# Resume Activation Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在定向简历自动保存和启用时检查整份最终文字，阻止占位符、联系方式损坏和无依据结构化个人事实，同时让篇幅或改动不足保持非阻塞提醒。

**Architecture:** 在现有 `resume_optimization.js` 增加一个纯校验函数，复用消息质量模块的结构化 token 提取，但使用更严格的源简历完整性规则。应用服务负责加载源简历、候选人事实与有效回答；保存返回错误/提醒供页面展示，启用在现有原子事务前重新校验点击时文字。

**Tech Stack:** Node.js 22.5+、CommonJS、现有定向简历服务与 SQLite 存储、服务端 HTML/原生浏览器脚本。

## Global Constraints

- 原始简历、系统生成基线和修改账本保持不可变。
- 严重错误阻止启用；几乎未修改、篇幅增加和用户额外编辑只提醒。
- 用户点击“启用为新版本”后，检查通过即直接启用，不增加二次确认或勾选步骤。
- 个人事实依据只来自源简历、当前有效候选人事实和适用回答；岗位 JD 与体检结论不能证明个人经历。
- 启用失败不能创建简历版本或策略轮次；成功时两者继续使用现有同一事务。
- 不重新判断历史已启用版本，不增加实体识别或简历排版依赖。

---

### Task 1: 整份简历完整性纯校验

**Files:**
- Modify: `src/core/resume_optimization.js`
- Modify: `tests/resume_optimization_contract_smoke.js`

**Interfaces:**
- Consumes: `extractHighRiskClaims()` and `normalizedMessageText()` from `src/core/message_draft_quality.js`.
- Produces: `validateResumeActivationText({ sourceText, generatedText, finalText, candidateName, facts, answerMemories, suggestions }) -> { valid, errors, warnings }`.

- [ ] **Step 1: Write failing contract tests**

```js
const result = validateResumeActivationText({
  sourceText: "候选人甲\n13800138000\nuser@example.com\n参与知识库开发 2 年",
  generatedText: "候选人甲\n13800138000\nuser@example.com\n参与 Node.js 知识库开发 2 年",
  finalText: "候选人甲\n待填写手机号\nuser@example.com\n主导知识库开发 5 年",
  candidateName: "候选人甲",
  facts: [],
  answerMemories: [],
  suggestions
});
assert.equal(result.valid, false);
assert(result.errors.some((item) => item.code === "RESUME_CONTACT_REMOVED"));
assert(result.errors.some((item) => item.code === "RESUME_PLACEHOLDER_PRESENT"));
assert(result.errors.some((item) => item.code === "RESUME_FACT_UNSUPPORTED"));
```

Add cases for removed name, changed phone/email/URL, new date/money/percentage/duration, facts supported by active answers, JD-only evidence rejected, empty/very short text, almost unchanged warning, 130% length warning and extra user edit warning.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/resume_optimization_contract_smoke.js`

Expected: FAIL because `validateResumeActivationText` is not exported.

- [ ] **Step 3: Implement source identity and placeholder checks**

```js
const PLACEHOLDER_PATTERNS = [
  /X{3,}/i,
  /待(?:填写|补充|确认)/,
  /T(?:ODO)/i,
  /(?:手机|电话|邮箱)[:：]?\s*(?:无|未填|示例)/
];
```

Extract source phone, email and URL tokens using shared high-risk claim parsing. Every source token must still occur after normalization. If `candidateName` occurs in the source, it must remain in the final text.

- [ ] **Step 4: Implement unsupported structured-fact checks**

Build candidate evidence from source text plus current facts and active answer text. Extract claims from final text, ignore tokens already present in source, and require each new claim in candidate evidence. Never add evidence catalog entries with `kind: "job"` or `kind: "diagnosis"`.

Before text checks, recompute the immutable generated baseline:

```js
const expectedGenerated = renderOptimizedResume(sourceText, suggestions);
if (comparableText(expectedGenerated) !== comparableText(generatedText)) {
  errors.push(issue("RESUME_GENERATED_BASELINE_CHANGED", "系统生成基线与修改记录不一致。"));
}
```

- [ ] **Step 5: Implement warnings**

- `RESUME_NEARLY_UNCHANGED` when normalized trigram similarity to source is at least `0.98`.
- `RESUME_LENGTH_INCREASED` when non-whitespace final length exceeds source by more than 30%.
- `RESUME_USER_EXTRA_EDIT` when final text differs from generated text.

Warnings never set `valid` to false.

- [ ] **Step 6: Run the contract test and commit**

Run: `node tests/resume_optimization_contract_smoke.js`

Expected: `resume_optimization_contract_smoke ok`.

```powershell
git add src/core/resume_optimization.js tests/resume_optimization_contract_smoke.js
git commit -m "feat: validate complete optimized resumes"
```

### Task 2: 服务层保存提醒和启用闸门

**Files:**
- Modify: `src/application/resume_optimization/index.js`
- Modify: `tests/resume_optimization_service_smoke.js`

**Interfaces:**
- Consumes: `validateResumeActivationText()`.
- Extends: `saveDraft()` result with `integrity: { valid, errors, warnings }`.
- Extends: `dashboard()` with `selectedIntegrity`.
- Throws: `RESUME_ACTIVATION_INTEGRITY_FAILED` with public `issues` when activation errors are present.

- [ ] **Step 1: Write failing service tests**

```js
const saved = service.saveDraft({ profileId, draftId, finalText: nearlyUnchanged });
assert.equal(saved.integrity.valid, true);
assert(saved.integrity.warnings.some((item) => item.code === "RESUME_NEARLY_UNCHANGED"));

assert.throws(
  () => service.activateDraft({ profileId, planId, draftId, finalText: textWithChangedPhone }),
  (error) => error.code === "RESUME_ACTIVATION_INTEGRITY_FAILED"
);
assert.equal(listCandidateResumeVersions(db, profileId).length, versionsBefore);
assert.equal(listFunnelStrategyRounds(db, { profileId, planId }).length, roundsBefore);
```

Add a successful activation with warnings and verify it still creates exactly one version and one active strategy round.

- [ ] **Step 2: Run the service test and verify RED**

Run: `node tests/resume_optimization_service_smoke.js`

Expected: FAIL because the service returns no integrity result and activation does not check it.

- [ ] **Step 3: Add one private context builder**

```js
function integrityFor(draft, finalText) {
  const source = ownedSource(draft.profileId, draft.sourceResumeVersionId);
  return validateResumeActivationText({
    sourceText: source.text,
    generatedText: draft.generatedText,
    finalText,
    candidateName: getCandidateProfile(db, draft.profileId)?.displayName || "",
    facts: listCandidateFacts(db, draft.profileId),
    answerMemories: listCandidateAnswerMemories(db, {
      profileId: draft.profileId,
      activeOnly: true,
      source: "user_edited_reply",
      limit: 100
    }),
    suggestions: draft.changeLedger
  });
}
```

Do not accept evidence or source text from the request body.

- [ ] **Step 4: Integrate save, dashboard and activate**

Save the final text first through the existing storage method, then return `{ ...saved, integrity }`. Dashboard computes `selectedIntegrity` from the selected draft's current final text. Activation computes integrity from the submitted click-time text before calling `activateResumeOptimization`; on error attach only bounded public issue objects.

- [ ] **Step 5: Run the service test and commit**

Run: `node tests/resume_optimization_service_smoke.js && node tests/resume_optimization_store_smoke.js`

Expected: both tests pass and store transaction assertions remain unchanged.

```powershell
git add src/application/resume_optimization/index.js tests/resume_optimization_service_smoke.js
git commit -m "feat: gate optimized resume activation"
```

### Task 3: 页面即时提醒和可读错误

**Files:**
- Modify: `src/dashboard/pages/resume_optimization.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/components.css`
- Modify: `tests/dashboard_resume_optimization_smoke.js`

**Interfaces:**
- Consumes: `dashboard.selectedIntegrity` and JSON save response `{ ok, integrity }`.
- Produces: inline `[data-resume-integrity]` error/warning list; activation failure JSON contains user-readable issues.

- [ ] **Step 1: Write failing page and client tests**

```js
assert.match(page.body, /这份草稿与原简历非常接近/);
assert.match(page.body, /篇幅比原简历明显增加/);
assert.doesNotMatch(page.body, /0\.98|30%|RESUME_NEARLY_UNCHANGED/);
```

Simulate autosave returning warnings and assert the inline region updates. Simulate activation returning `RESUME_ACTIVATION_INTEGRITY_FAILED` and assert the button is re-enabled, exact user message appears, the page does not navigate and no confirmation dialog is created.

- [ ] **Step 2: Run the page test and verify RED**

Run: `node tests/dashboard_resume_optimization_smoke.js`

Expected: FAIL because integrity messages are not rendered or returned.

- [ ] **Step 3: Render stable public copy**

Map codes on the server/page boundary:

```js
const INTEGRITY_MESSAGES = Object.freeze({
  RESUME_PLACEHOLDER_PRESENT: "简历里还有待补充的占位内容。",
  RESUME_CONTACT_REMOVED: "原简历中的姓名或联系方式被删除或改动。",
  RESUME_FACT_UNSUPPORTED: "简历新增了系统找不到依据的日期、数字或联系方式。",
  RESUME_NEARLY_UNCHANGED: "这份草稿与原简历非常接近，定向调整可能不明显。",
  RESUME_LENGTH_INCREASED: "篇幅比原简历明显增加，建议再精简。",
  RESUME_USER_EXTRA_EDIT: "当前全文包含你在系统优化后继续修改的内容。"
});
```

Do not send source text, claim tokens, evidence text or model suggestions in an error response.

- [ ] **Step 4: Return integrity from autosave and activation errors**

`handleResumeOptimizationSave` returns `{ ok: true, integrity }`. The activation handler catches only `RESUME_ACTIVATION_INTEGRITY_FAILED` and returns 409 JSON when called by `fetch`; unrelated errors continue to the existing error boundary. The client waits for pending autosaves, submits click-time `finalText`, and navigates only on success.

- [ ] **Step 5: Run page tests and commit**

Run: `node tests/dashboard_resume_optimization_smoke.js && node tests/resume_optimization_service_smoke.js`

Expected: both tests pass; existing late-autosave versus activation ordering remains protected.

```powershell
git add src/dashboard/pages/resume_optimization.js src/dashboard/server.js src/dashboard/assets/components.css tests/dashboard_resume_optimization_smoke.js
git commit -m "feat: explain resume integrity before activation"
```

### Task 4: 完整门禁和交接更新

**Files:**
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`

- [ ] **Step 1: Run the complete resume gate**

```powershell
node tests/message_draft_quality_smoke.js
node tests/resume_optimization_contract_smoke.js
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/dashboard_resume_optimization_smoke.js
npm test
git diff --check
git status --short
```

Expected: focused tests print `ok`; full suite reports the current exact total; diff check has no output.

- [ ] **Step 2: Update current documentation**

Record blocking versus warning behavior, lack of second confirmation, exact validation results, no historical rewrite and real-platform non-access.

- [ ] **Step 3: Commit documentation**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md
git commit -m "docs: record resume activation integrity delivery"
```
