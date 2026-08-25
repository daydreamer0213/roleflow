# Message Discovery Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate recruiter communicative intent from message topic so only a real interview invitation advances interview progress, while the page leads with a useful conclusion and local draft.

**Architecture:** Keep the existing single `draftMessageGroup` model call. Add a validated `messageIntent` field beside `messageCategory`; use intent for progress and user-facing meaning, and retain category plus fact state for draft safety. Carry only the enum through transient results and safe progress metadata—never persist recruiter text or drafts.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:assert`, SQLite, server-rendered HTML, existing OpenAI-compatible and offline Mock adapters.

## Global Constraints

- Do not add dependencies, model calls, model task profiles, services, database migrations, or frontend frameworks.
- Do not change BOSS tab handling, background detail reads, pacing, cooldowns, access budgets, checkpoints, or risk-control behavior.
- Do not access real BOSS or perform any real communication, paste, send, application, push, merge, package, or release action.
- Keep recruiter message text, generated drafts, model raw output, and intent evidence out of persistent progress metadata.
- Preserve existing fail-closed handling for salary, sensitive information, uncertain job identity, missing facts, model failures, and existing interview progress.

---

### Task 1: Validate semantic intent in the existing model call

**Files:**
- Modify: `tests/message_reply_contract_smoke.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/core/message_reply_contract.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`

**Interfaces:**
- Consumes: `createMessageReplyAnalyzer({ adapter })` and `adapter.draftMessageGroup(input)`.
- Produces: validated result `{ messageIntent, messageCategory, messageSummary, requiredFactKeys, usedFactKeys, responseItems, coverage, missingFact, messages, progressUpdate }`; exported `MESSAGE_INTENTS` set.

- [ ] **Step 1: Add failing contract checks for the new intent field**

Update the `safeReply` fixture so its default is an information request:

```js
function safeReply(overrides = {}) {
  return {
    messageIntent: "information_request",
    messageCategory: "availability",
    messageSummary: "对方正在确认候选人的到岗时间。",
    requiredFactKeys: ["employment_status", "availability_date"],
    usedFactKeys: ["employment_status", "availability_date"],
    responseItems: [
      { id: "employment_status", kind: "question", required: true },
      { id: "availability_date", kind: "question", required: true }
    ],
    coverage: [
      { responseItemId: "employment_status", covered: true },
      { responseItemId: "availability_date", covered: true }
    ],
    missingFact: null,
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "ignored provider text"
    },
    messages: ["complete draft"],
    ...overrides
  };
}
```

Add assertions that:

```js
assert.throws(
  () => validateMessageReply(safeReply({ messageIntent: "keyword_interview" }), { facts: validFacts, now: NOW }),
  (error) => error.code === "MESSAGE_REPLY_INTENT_INVALID"
);

const mentionedInterview = validateMessageReply(safeReply({
  messageIntent: "information_update",
  messageCategory: "other",
  messageSummary: "对方在介绍岗位涉及的面试安排系统。",
  requiredFactKeys: [],
  usedFactKeys: [],
  responseItems: [],
  coverage: [],
  messages: ["了解了，谢谢你补充岗位信息。"]
}), { facts: [], now: NOW });
assert.strictEqual(mentionedInterview.progressUpdate.stage, "reply_ready");

const invitation = validateMessageReply(safeReply({
  messageIntent: "interview_invitation",
  messageCategory: "other",
  messageSummary: "对方正式邀请候选人参加面试。",
  requiredFactKeys: [],
  usedFactKeys: [],
  responseItems: [],
  coverage: [],
  messages: ["我确认明天下午参加面试。"]
}), { facts: [], now: NOW });
assert.strictEqual(invitation.progressUpdate.stage, "interview_invited");
assert.deepStrictEqual(invitation.messages, ["您好，感谢邀请，请问面试时间和形式如何安排？"]);
```

Add one assertion for each non-interview intent: `interest_check`, `information_request`, `information_update`, `general_communication`, and `manual_review`. `manual_review` must have no drafts and must yield `needs_user_action`.

- [ ] **Step 2: Run the contract test and confirm RED**

Run: `node tests/message_reply_contract_smoke.js`

Expected: failure because `messageIntent` is neither validated nor used to derive progress.

- [ ] **Step 3: Implement the minimal reply contract**

In `src/core/message_reply_contract.js`:

```js
const MESSAGE_INTENTS = new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "manual_review"
]);
```

Read and validate `value.messageIntent` in `normalizeReply`; return it in the normalized object. Remove `interview_invitation` from `MESSAGE_CATEGORIES`, because that enum now describes topic only. Make `manual_review` draftless, make only `messageIntent === "interview_invitation"` receive `SAFE_INTERVIEW_DRAFT`, and derive stages exactly as follows:

```js
function safeReplyStage(normalized) {
  if (normalized.messageIntent === "interview_invitation") return "interview_invited";
  if (normalized.messageIntent === "manual_review") return "needs_user_action";
  return normalized.messages.length ? "reply_ready" : "needs_user_action";
}
```

Export `MESSAGE_INTENTS` with the existing contract exports.

- [ ] **Step 4: Add failing adapter checks for semantic distinctions**

In `tests/model_adapter_smoke.js`, assert the Mock returns these intent/category pairs:

```js
[
  ["这个岗位负责开发面试安排管理系统。", "information_update", "other"],
  ["看过你的简历，想问问你是否有意向了解这个岗位？", "interest_check", "other"],
  ["请补充说明你在知识库项目中具体负责什么。", "information_request", "project_fact"],
  ["你好，方便沟通一下这个岗位吗？", "interest_check", "other"],
  ["想邀请你参加面试，请问明天下午方便吗？", "interview_invitation", "other"]
]
```

Also require the OpenAI-compatible prompt to contain `messageIntent`, all six allowed values, the four contrastive examples from the design, and the instruction that only a direct request to attend/confirm/select an interview is an invitation.

- [ ] **Step 5: Run the adapter test and confirm RED**

Run: `node tests/model_adapter_smoke.js`

Expected: failure because adapters do not return `messageIntent` and the prompt lacks the full semantic contract.

- [ ] **Step 6: Update both adapters without adding a call**

In `src/adapters/models/openai_compatible.js`, keep one `chatJson` call and expand the current prompt with:

```js
"messageIntent 只能是 interview_invitation/interest_check/information_request/information_update/general_communication/manual_review。",
"只有招聘方直接要求候选人参加、确认或选择一场面试，才是 interview_invitation。询问是否愿意了解岗位是 interest_check；索要候选人信息是 information_request；补充岗位或流程信息是 information_update；只提到面试产品、流程、系统、功能或经历不是面试邀约。",
"对照：‘想邀请你参加周三下午的面试’是 interview_invitation；‘是否有意向了解这个岗位’是 interest_check；‘请补充你在项目中的职责’是 information_request；‘这个岗位负责开发面试安排系统’是 information_update。",
"输出 JSON：messageIntent、messageCategory、messageSummary、requiredFactKeys、usedFactKeys、responseItems[{id,kind,required}]、coverage[{responseItemId,covered}]、missingFact（无则为 null）、messages（最大 2 条）、progressUpdate{stage,nextAction}。"
```

Make `messageCategory` topic-only: `project_fact/qualification/salary/availability/sensitive/other/identity_uncertain`.

In the offline Mock, calculate `messageIntent` separately from `messageCategory`, return both, and make formal invitations use category `other`. The Mock is only a deterministic fixture; production semantics remain model-driven. Check descriptive/product language before generic questions so “面试安排管理系统” is an information update, while an explicit invitation in the same turn remains an invitation.

- [ ] **Step 7: Run Task 1 tests and confirm GREEN**

Run:

```powershell
node tests/message_reply_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: both print their `ok` line and exit 0.

- [ ] **Step 8: Commit Task 1**

```powershell
git add -- src/core/message_reply_contract.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/message_reply_contract_smoke.js tests/model_adapter_smoke.js
git commit -m "feat: separate recruiter intent from message topic"
```

### Task 2: Carry intent through progress and safe results

**Files:**
- Modify: `tests/candidate_progress_storage_smoke.js`
- Modify: `tests/message_discovery_smoke.js`
- Modify: `src/core/candidate_progress.js`
- Modify: `src/core/message_discovery.js`

**Interfaces:**
- Consumes: validated `messageIntent` from Task 1.
- Produces: `recordDiscoveredMessageGroupClassification(db, { messageIntent, messageCategory, progressUpdate })`; safe result field `messageIntent`; progress metadata field `messageIntent`.

- [ ] **Step 1: Add failing persistence and discovery assertions**

Add `messageIntent: "information_request"` to the grouped classification storage fixture and assert the group and individual message events both contain it. Assert serialized event rows do not contain recruiter text or a draft sentinel.

Update the `classification` helper in `tests/message_discovery_smoke.js` to default to `messageIntent: "information_request"`. Add a result where the summary mentions an interview system but the intent is `information_update`, then assert:

```js
assert.strictEqual(summary.results[0].messageIntent, "information_update");
assert.strictEqual(summary.results[0].stage, "reply_ready");
assert.notStrictEqual(summary.results[0].stage, "interview_invited");
```

For the model-contract failure case, require `messageIntent === "manual_review"`, `stage === "needs_user_action"`, and `messages` to be empty.

- [ ] **Step 2: Run persistence and discovery tests and confirm RED**

Run:

```powershell
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
```

Expected: failure because `messageIntent` is not persisted or projected.

- [ ] **Step 3: Persist only the safe intent enum**

In `src/core/candidate_progress.js`:

- add `messageIntent` to `ALLOWED_METADATA_KEYS`;
- add the same six-value `MESSAGE_INTENTS` set used by the reply contract;
- validate `input.messageIntent` in `recordDiscoveredMessageGroupClassification`;
- include `messageIntent` in group and individual message classification metadata;
- make `sanitizedMessageSummary` prefer “收到面试邀约” only when `messageIntent === "interview_invitation"`; otherwise retain the topic-safe summary;
- export `MESSAGE_INTENTS` only if tests or sibling modules require it; do not create a new shared module for two short sets.

- [ ] **Step 4: Project intent through discovery**

In `src/core/message_discovery.js`:

- include `messageIntent` in the call to `recordDiscoveredMessageGroupClassification`;
- include `messageIntent` in `safeResult`;
- replace the contract-failure fallback with:

```js
classification = {
  messageIntent: "manual_review",
  messageCategory: "other",
  messageSummary: "这条消息暂时无法可靠判断，需要人工确认。",
  missingFact: null,
  messages: [],
  manualActionReason: "model_contract_invalid",
  progressUpdate: { stage: "needs_user_action" }
};
```

- use `messageIntent`, not category text, for any interview-specific result handling;
- keep `MANUAL_ONLY_CATEGORIES` and missing-fact draft suppression unchanged.

- [ ] **Step 5: Run Task 2 tests and confirm GREEN**

Run:

```powershell
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
node tests/message_discovery_job_context_smoke.js
```

Expected: all three print their `ok` line and exit 0.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/core/candidate_progress.js src/core/message_discovery.js tests/candidate_progress_storage_smoke.js tests/message_discovery_smoke.js
git commit -m "feat: preserve message intent in progress results"
```

### Task 3: Lead the message page with the user conclusion

**Files:**
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`

**Interfaces:**
- Consumes: safe result `{ messageIntent, messageSummary, job, messages, manualActionReason }` from Task 2.
- Produces: server-rendered message result ordered as conclusion → opportunity/job facts → next step/draft.

- [ ] **Step 1: Add failing controller and page assertions**

Update dashboard run fixtures to include `messageIntent`. Require the controller page state to retain it while the public polling JSON continues to omit `messageSummary` and draft content.

Update page assertions to require these headings in order:

```js
[
  "<h3>结论</h3>",
  "<h3>这份机会</h3>",
  "<h3>岗位主要做什么</h3>",
  "<h3>公司做什么</h3>",
  "<h3>匹配度</h3>",
  "<h3>薪资</h3>",
  "<h3>下一步</h3>"
]
```

Require natural labels “正式面试邀约”, “询问是否有意向”, “需要你补充信息”, “对方补充了信息”, “普通沟通”, and “需要人工判断”. Assert raw enum values such as `interview_invitation`, `information_request`, and `manual_review` are absent from markup.

- [ ] **Step 2: Run the dashboard test and confirm RED**

Run: `node tests/dashboard_message_discovery_smoke.js`

Expected: failure because the controller drops `messageIntent` and the page still renders the old heading order.

- [ ] **Step 3: Sanitize and render intent**

In `src/dashboard/message_discovery_controller.js`, add:

```js
messageIntent: new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "manual_review"
]).has(item?.messageIntent) ? item.messageIntent : "manual_review",
```

Keep `publicRun` restricted to identifiers, stages, topic and missing fact; the full page-only state may include the safe intent enum and summary.

In `src/dashboard/message_discovery_view.js`, replace `messageCategoryLabel` with:

```js
function messageIntentLabel(value) {
  return {
    interview_invitation: "正式面试邀约",
    interest_check: "询问是否有意向",
    information_request: "需要你补充信息",
    information_update: "对方补充了信息",
    general_communication: "普通沟通",
    manual_review: "需要人工判断"
  }[String(value || "")] || "需要人工判断";
}
```

Render conclusion first, then current opportunity verdict and the existing safe job projection, then the next step. Remove the leading internal “消息：类别” text. Make manual action copy inspect `messageIntent === "manual_review"` rather than searching category text for “interview”.

- [ ] **Step 4: Run Task 3 test and confirm GREEN**

Run: `node tests/dashboard_message_discovery_smoke.js`

Expected: prints `dashboard_message_discovery_smoke ok` and exits 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: lead message results with recruiter intent"
```

### Task 4: Update authority docs and run the complete gate

**Files:**
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Verify: all changed source, test, design and plan files.

**Interfaces:**
- Consumes: completed message discovery implementation and verification evidence.
- Produces: current handoff state pointing to the next independent topic, job analysis.

- [ ] **Step 1: Update authority docs with current facts**

In both authority docs, record:

- message intent is now separate from topic and only explicit interview invitations advance interview progress;
- results lead with the conclusion and job opportunity before local drafts;
- one existing deep-analysis model call is reused; no additional call or model profile was added;
- synthetic offline coverage exists, while real model semantic accuracy and real BOSS behavior were not tested in this stage;
- current branch SHA and full gate result after they are known;
- the next entry is the independent job analysis evidence review, including the historical-failure/current-unresolved-state bug.

Remove superseded statements that describe message intent work as not yet started. Do not rewrite unrelated browser acceptance history.

- [ ] **Step 2: Run targeted message discovery checks**

Run:

```powershell
node tests/message_reply_contract_smoke.js
node tests/model_adapter_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/message_discovery_smoke.js
node tests/message_discovery_job_context_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: every test prints its `ok` line and exits 0.

- [ ] **Step 3: Run the full offline gate**

Run: `npm test`

Expected: exit 0 with final line `All 107 offline checks passed.`

- [ ] **Step 4: Inspect the final worktree**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD
```

Expected: `git diff --check` exits 0; status contains only the intended authority-document changes before the final commit; the diff stat contains no package lock, generated artifact, database, log, browser profile or secret file.

- [ ] **Step 5: Commit verified authority docs**

```powershell
git add -- docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md
git commit -m "docs: hand off semantic message discovery"
```

- [ ] **Step 6: Record final evidence**

Run:

```powershell
git rev-parse HEAD
git status --short --branch
```

Expected: branch remains `codex/message-discovery-job-analysis`, worktree is clean, and no push has occurred.
