# Résumé-General Mock Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this repository, use `executing-plans` in the current task; do not spawn subagents unless the user later explicitly asks for delegation.

**Goal:** Make résumé-based general interview practice the default flow without requiring a job or interview invitation, while preserving the current job-specific mode as an optional second path.

**Architecture:** Rebuild the interview session table in migration 25 so a session records `resume_general` or `job_specific` and general sessions may have no job. Freeze a line-level résumé evidence catalog plus only global/experience-scoped memories and facts. Require every generated question to cite real résumé evidence; continue to require later questions to quote the immediately previous answer. Reuse the current turn persistence, report, retry, and concurrency behavior.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite`, existing model adapters and privacy preparation, server-rendered Dashboard, offline smoke tests.

## Global Constraints

- `resume_general` is the default and requires only an owned active résumé; it does not require a job, complete JD, or external interview invitation.
- `job_specific` remains available and keeps its owned complete-JD requirement.
- Freeze the selected résumé version, redacted résumé text, line-level résumé evidence catalog, current applicable facts/memories, and prior weaknesses when the session starts.
- General mode may use only global and experience answer-memory scopes. Job and company scopes must not enter its model context.
- Direct user facts may enter general mode; answer-derived facts enter only when their active memory scope is global or experience.
- Every question cites 1–4 existing résumé evidence IDs. A follow-up also cites the immediately previous turn and quotes a literal answer excerpt in both `answerEvidence` and question text.
- A model failure before persistence creates no session; a later model failure preserves all already stored turns and answers.
- Reports and retries stay bound to real turn numbers and never create candidate facts, scores, offer probabilities, or “perfect answers”.
- Old sessions migrate to `job_specific` without losing job, context, turns, answers, reports, or retries.
- Do not add company research, industry browsing, external question banks, audio, video, or BOSS access.
- Add no dependency or new frontend framework.

---

## Task 1: Migrate Sessions to Explicit General and Job-Specific Kinds

**Files:**

- Modify: `src/core/storage.js`
- Modify: `src/storage/mock_interview_store.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/mock_interview_store_smoke.js`

**Interfaces:**

- Consumes: existing mock interview session/turn/retry tables at schema v24.
- Produces the existing store methods with these extended inputs/outputs:

```js
createMockInterviewSession(db, {
  profileId, planId, sessionKind, jobId, resumeVersionId,
  context, settings, initialQuestion, modelIdentity
})

listMockInterviewSessions(db, {
  profileId, planId = null, sessionKind = "", limit = 30
})

// session row adds sessionKind and nullable jobId
// turn row adds resumeEvidenceIds
```

- [x] **Step 1: Write failing migration and store tests**

In `tests/mock_interview_store_smoke.js`, create a general session:

```js
const general = storage.createMockInterviewSession(db, {
  profileId,
  planId,
  sessionKind: "resume_general",
  jobId: null,
  resumeVersionId,
  context: frozenGeneralContext,
  settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
  initialQuestion: {
    text: "简历中写到企业知识库，请介绍这段经历。",
    focus: "experience",
    resumeEvidenceIds: ["R2"],
    basedOnTurnNumber: null,
    answerEvidence: ""
  }
});
assert.equal(general.sessionKind, "resume_general");
assert.equal(general.jobId, null);
assert.deepEqual(general.turns[0].resumeEvidenceIds, ["R2"]);
```

Assert `job_specific` still rejects null/foreign jobs, general mode rejects a supplied foreign job instead of using it, and profile-wide `listMockInterviewSessions({ profileId, sessionKind: "resume_general" })` can collect prior general sessions across plans.

Create a v24 fixture with a completed job-bound session and retry. Reopen through `openDb`; assert it becomes `job_specific` and every old field remains byte-for-byte equivalent except the new defaults.

- [x] **Step 2: Run store and migration tests and verify failure**

```powershell
node tests/mock_interview_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: failure because `job_id` is still non-null and the new fields do not exist.

- [x] **Step 3: Add migration 25 with a guarded table rebuild**

Add:

```js
{
  version: 25,
  name: "mock_interview_resume_general_v3",
  apply(db) {
    migrateMockInterviewResumeGeneral(db);
  }
}
```

Rebuild `mock_interview_sessions` inside the existing migration transaction with:

```sql
session_kind TEXT NOT NULL CHECK(session_kind IN ('resume_general','job_specific')),
job_id INTEGER,
CHECK(
  (session_kind = 'resume_general' AND job_id IS NULL) OR
  (session_kind = 'job_specific' AND job_id IS NOT NULL)
)
```

Copy all old rows as `job_specific`; recreate profile/plan indexes and preserve IDs so turn/retry foreign keys remain valid. Add `resume_evidence_ids_json TEXT NOT NULL DEFAULT '[]'` to `mock_interview_turns`. Update the fresh schema to match v25.

- [x] **Step 4: Extend store validation and mapping**

Normalize `sessionKind` to the two allowed values. For `resume_general`, require `jobId` to be absent; for `job_specific`, run the existing owned-job check. Keep plan and active-résumé ownership for both. Map a SQL null job as `jobId: null`, not numeric zero, and expose `sessionKind` on every mapped session.

Extend `questionInput`:

```js
const resumeEvidenceIds = [...new Set((value.resumeEvidenceIds || [])
  .map((item) => String(item).trim()).filter(Boolean))];
if (resumeEvidenceIds.length < 1 || resumeEvidenceIds.length > 4) {
  throw new Error("问题必须引用 1-4 条简历证据");
}
```

Persist and map `resume_evidence_ids_json` on every turn. Keep answer/next-question insertion in one transaction.

- [x] **Step 5: Run storage regressions**

```powershell
node tests/mock_interview_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: pass with old job-specific data preserved and general sessions jobless.

- [x] **Step 6: Commit the schema checkpoint**

```powershell
git add src/core/storage.js src/storage/mock_interview_store.js tests/storage_migration_smoke.js tests/mock_interview_store_smoke.js
git commit -m "feat: add resume general interview sessions"
```

---

## Task 2: Require Résumé Evidence on Every Interview Question

**Files:**

- Modify: `src/core/mock_interview.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `tests/mock_interview_contract_smoke.js`
- Modify: `tests/model_adapter_smoke.js`

**Interfaces:**

- Consumes: redacted résumé text and current turn list.
- Produces:

```js
buildResumeInterviewEvidenceCatalog(sourceText)
// => [{ id: "R1", kind: "resume", text: "..." }]

validateInterviewStep(raw, {
  turns,
  resumeEvidenceCatalog,
  sessionKind
})
```

`nextQuestion` becomes:

```js
{
  text, focus, resumeEvidenceIds,
  basedOnTurnNumber, answerEvidence
}
```

- [x] **Step 1: Add failing evidence-contract cases**

In `tests/mock_interview_contract_smoke.js`, assert a general first question with `resumeEvidenceIds: ["R2"]` succeeds. Reject missing IDs, unknown IDs, more than four IDs, a first question that quotes an answer, and a follow-up that omits either résumé evidence or the literal previous-answer excerpt.

Use this valid follow-up shape:

```js
{
  text: "你刚才提到“接口联调”，结合简历中的知识库项目说明你具体做了什么。",
  focus: "contribution",
  resumeEvidenceIds: ["R2"],
  basedOnTurnNumber: 1,
  answerEvidence: "接口联调"
}
```

- [x] **Step 2: Run contract tests and verify failure**

```powershell
node tests/mock_interview_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: failure because résumé evidence IDs are not validated or generated.

- [x] **Step 3: Build and validate the line-level evidence catalog**

Implement `buildResumeInterviewEvidenceCatalog` by splitting non-empty trimmed résumé lines and assigning stable `R1`, `R2`, ... IDs in source order. Reject empty résumé evidence.

Extend `normalizeQuestion` and `validateInterviewStep` to validate every cited ID against the frozen catalog. Keep all current planned-question, turn-number, literal answer excerpt, early-completion, and report rules unchanged.

- [x] **Step 4: Update the real adapter prompt**

Require `resumeEvidenceIds` in every `nextQuestion`. Tell the adapter:

- `context.sessionKind === "resume_general"` means no job is available and questions must cover résumé timeline, roles/contributions, challenges/tradeoffs/results, skills, gaps/transitions, and résumé-derived behavior stories;
- `job_specific` may additionally use the complete JD;
- every first question cites résumé evidence;
- every later question cites résumé evidence and the immediately preceding answer excerpt;
- no company research, invented fact, score, or offer probability.

- [x] **Step 5: Update the deterministic mock adapter**

For a first question, choose the first available `context.resumeEvidenceCatalog` ID and quote its text, working whether `context.job` is null or present. Follow-ups retain that evidence ID and the literal answer excerpt. General-mode copy must not say “这个岗位” when no job exists.

- [x] **Step 6: Run contract and adapter regressions**

```powershell
node tests/mock_interview_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: pass.

- [x] **Step 7: Commit the evidence contract**

```powershell
git add src/core/mock_interview.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/mock_interview_contract_smoke.js tests/model_adapter_smoke.js
git commit -m "feat: ground interview questions in resume evidence"
```

---

## Task 3: Build Scope-Safe General Interview Context

**Files:**

- Modify: `src/core/mock_interview.js`
- Modify: `src/application/mock_interview/index.js`
- Modify: `tests/mock_interview_service_smoke.js`

**Interfaces:**

- Consumes: `listCandidateAnswerMemories`, `listCandidateFactRevisions`, profile-wide general interview history, privacy preparation, and evidence catalog from Task 2.
- Produces:

```js
projectInterviewFacts({ factRevisions, answerMemories, allowedScopeKinds })

service.startSession({
  profileId,
  planId,
  sessionKind = "resume_general",
  jobId = null,
  resumeVersionId,
  settings
})
```

- [x] **Step 1: Add failing general-context fixtures**

Seed active answer memories with `global`, `experience`, `job`, and `company` scopes plus fact revisions tied to each. Start a general session and assert:

```js
assert.equal(modelInput.context.sessionKind, "resume_general");
assert.equal(modelInput.context.job, null);
assert(modelInput.context.answerMemories.every((item) =>
  ["global", "experience"].includes(item.scope.kind)));
assert(!JSON.stringify(modelInput.context).includes("仅适用于某公司"));
assert(!JSON.stringify(modelInput.context).includes("仅适用于岗位 71"));
assert(modelInput.context.resumeEvidenceCatalog.length > 0);
```

Seed an older completed general session on another plan and a job-specific session with different weaknesses. Assert only the general weakness appears. Assert a model failure creates no session and a later follow-up failure leaves the previously persisted answer unchanged.

- [x] **Step 2: Run the service test and verify failure**

```powershell
node tests/mock_interview_service_smoke.js
```

Expected: failure because starting a session still requires an owned complete job and context has no evidence catalog.

- [x] **Step 3: Implement scope-safe fact projection**

In `src/core/mock_interview.js`, implement `projectInterviewFacts`:

1. discard any revision with `withdrawnAt`;
2. map active answer memories by ID;
3. retain direct revisions with no `answerMemoryId`;
4. retain answer-derived revisions only when the linked active memory scope is in `allowedScopeKinds`;
5. rank direct revisions by `createdAt` and answer-derived revisions by their memory `updatedAt`;
6. for each `factKey`, choose the newest revision containing that key; a selected delete removes the key;
7. return `{ factKey, factValue, source }` without scope-leaking evidence text.

This preserves the stage-one “a polite no-fact edit does not hide an older fact” behavior because only revisions containing the same fact key compete.

- [x] **Step 4: Split frozen context by session kind**

For `resume_general`:

- validate only the owned active résumé;
- redact it with `prepareResumeTextForModel`;
- build `resumeEvidenceCatalog` from the redacted text;
- include active global/experience answer memories;
- project direct plus global/experience facts;
- collect up to eight weaknesses from completed profile-wide `resume_general` sessions only;
- store `job: null` and `sessionKind: "resume_general"`.

For `job_specific`, retain the current owned complete-job path and applicable job/company/global/experience answers, add the same résumé evidence catalog, and collect only prior `job_specific` weaknesses.

For migrated active sessions whose frozen `context_json` predates evidence catalogs, derive the same deterministic catalog in memory from `context.resume.text` whenever the service loads the session. Do not rewrite its stored context or hash. Old turns may keep an empty evidence list, while every newly generated question must use the derived catalog and persist valid IDs; this lets an interrupted pre-v25 session continue without pretending old questions had citations they never stored.

- [x] **Step 5: Pass evidence into every validation call**

At start and after every answer, call:

```js
validateInterviewStep(rawStep, {
  turns,
  resumeEvidenceCatalog: context.resumeEvidenceCatalog,
  sessionKind: context.sessionKind
});
```

Persist only after adapter output passes validation. Keep the existing planned-question count checks and finish-flight deduplication.

- [x] **Step 6: Run service and storage regressions**

```powershell
node tests/mock_interview_service_smoke.js
node tests/mock_interview_store_smoke.js
node tests/message_learning_store_smoke.js
```

Expected: pass, including no job/company scope leakage.

- [x] **Step 7: Commit the general context flow**

```powershell
git add src/core/mock_interview.js src/application/mock_interview/index.js tests/mock_interview_service_smoke.js
git commit -m "feat: build resume general interview context"
```

---

## Task 4: Make General Practice the Default Dashboard Flow

**Files:**

- Modify: `src/dashboard/pages/mock_interview.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `tests/dashboard_mock_interview_smoke.js`

**Interfaces:**

- Consumes: session kinds, nullable job, evidence catalog, and service start signature from Tasks 1–3.
- Produces: one start form with default `sessionKind=resume_general` and optional job-specific controls.

- [x] **Step 1: Write failing default-mode and evidence-display assertions**

Update `tests/dashboard_mock_interview_smoke.js`:

```js
assert.match(page.body, /简历通用面试/);
assert.match(page.body, /岗位专项面试/);
assert.match(page.body, /value="resume_general" checked/);
assert.match(page.body, /这道题来自简历/);
assert.match(page.body, /参与知识库开发/);
```

POST a general start with no `jobId` and assert:

```js
assert.deepEqual(calls.start[0], {
  profileId, planId, sessionKind: "resume_general", jobId: null,
  resumeVersionId, settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
});
```

POST job-specific start and assert the numeric job ID is retained. Confirm no browser-readiness probe occurs in either mode.

- [x] **Step 2: Run the Dashboard test and verify failure**

```powershell
node tests/dashboard_mock_interview_smoke.js
```

Expected: failure because the current form requires a job and does not display résumé evidence.

- [x] **Step 3: Render two clearly separated modes**

Make “简历通用面试” the checked default. Its copy says it works before an invitation and asks only for an active résumé. “岗位专项面试” reveals the complete-JD job selector as an optional second mode. Use the existing type, difficulty, and planned-question controls for both.

The client script toggles the job panel and `required` attribute based on session kind; normal form submission remains functional without JavaScript for the default general mode.

- [x] **Step 4: Render frozen binding and question evidence**

For general sessions, binding copy names the résumé and “通用训练” without a blank company/job. For job-specific sessions, retain job/JD binding.

Resolve each turn's `resumeEvidenceIds` against `session.context.resumeEvidenceCatalog` and render escaped excerpts under “这道题来自简历”. For follow-ups, also keep the existing indication that the question follows the previous answer; never render raw memory/fact internals.

- [x] **Step 5: Update the start handler**

Pass:

```js
{
  profileId: plan.profileId,
  planId: plan.id,
  sessionKind: params.sessionKind || "resume_general",
  jobId: params.sessionKind === "job_specific" ? Number(params.jobId) : null,
  resumeVersionId: Number(params.resumeVersionId),
  settings: {
    type: params.type,
    difficulty: params.difficulty,
    plannedQuestions: Number(params.plannedQuestions)
  }
}
```

Keep answer, finish, retry, and redirect paths unchanged.

- [x] **Step 6: Add minimal accessible styles and behavior**

Reuse current cards. Add mode-picker, conditional job panel, and evidence excerpt styles with visible focus and mobile stacking. Update `MOCK_INTERVIEW_SCRIPT` without introducing a bundle or dependency.

- [x] **Step 7: Run Dashboard and concurrency regressions**

```powershell
node tests/dashboard_mock_interview_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/dashboard_shell_smoke.js
```

Expected: pass, including the existing parallel-finish single-flight assertion.

- [x] **Step 8: Commit the default general-practice UI**

```powershell
git add src/dashboard/pages/mock_interview.js src/dashboard/server.js src/dashboard/assets/roleflow.css tests/dashboard_mock_interview_smoke.js
git commit -m "feat: default to resume general interview practice"
```

---

## Task 5: Final Stage-Four Verification and Documentation

**Files:**

- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-29-resume-general-mock-interview.md`

**Interfaces:**

- Consumes: all stage-four implementation tasks.
- Produces: verified résumé-general interview checkpoint and an explicit list of deferred external enhancements.

- [x] **Step 1: Run focused stage-four checks**

```powershell
node tests/storage_migration_smoke.js
node tests/mock_interview_contract_smoke.js
node tests/mock_interview_store_smoke.js
node tests/mock_interview_service_smoke.js
node tests/dashboard_mock_interview_smoke.js
node tests/model_adapter_smoke.js
node tests/message_learning_store_smoke.js
```

Expected: all pass.

- [x] **Step 2: Run the complete offline gate**

```powershell
npm test
```

Expected: a fresh `All <current count> offline checks passed.` result.

- [x] **Step 3: Update project handoff documents**

Record that résumé-general practice is the primary entry, job-specific remains optional, questions cite résumé evidence, scope leakage is prevented, old sessions migrated, and the exact offline count passed. Explicitly list company/industry research, external question banks, voice, and real-platform access as not implemented. State that no real BOSS or user interview data was accessed.

- [x] **Step 4: Check plan completion and diff hygiene**

```powershell
rg -n "^- \[ \]" docs/superpowers/plans/2026-08-29-resume-general-mock-interview.md
git diff --check
git status --short
```

Expected: no unchecked step, no whitespace error, and only intended documentation changes.

- [x] **Step 5: Commit the stage-four closeout**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-29-resume-general-mock-interview.md
git commit -m "docs: close resume general interview stage"
```

- [x] **Step 6: Verify the exact final commit**

```powershell
node tests/mock_interview_store_smoke.js
node tests/mock_interview_service_smoke.js
node tests/dashboard_mock_interview_smoke.js
git diff --check HEAD^
git status --short --branch
git rev-parse HEAD
```

Expected: focused tests pass and worktree is clean. Do not push, merge, package, change the version, create a release, or perform any real external action without a new explicit user request.
