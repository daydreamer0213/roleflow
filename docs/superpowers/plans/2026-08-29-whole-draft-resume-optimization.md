# Whole-Draft Résumé Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this repository, use `executing-plans` in the current task; do not spawn subagents unless the user later explicitly asks for delegation.

**Goal:** Generate one complete, editable, evidence-grounded résumé draft for a selected direction, explain every system change, and atomically start a new funnel strategy round when the user activates the edited result.

**Architecture:** Keep the existing validated patch model internally because it can prove exact anchors and reject unsupported numbers, but auto-apply every validated patch before the draft reaches the user. Persist the generated baseline separately from the user's current full text; render the patches as a read-only change ledger. Select 3–5 representative complete JDs deterministically from the chosen direction, and join résumé activation to the strategy-round boundary in one SQLite transaction.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite` and `node:crypto`, existing model adapters, server-rendered Dashboard with small inline autosave JavaScript, offline smoke tests.

## Global Constraints

- The user chooses a source résumé and target direction; the system chooses representative jobs without per-job approval.
- Use at most five complete, trusted JDs; prefer 3–5 when available, recent jobs, recommendation-ready jobs, and distinct companies.
- If no complete trusted JD supports the direction, create no optimization row and explain the missing evidence.
- The primary artifact is a complete editable résumé, not a list of suggestions requiring accept/edit/ignore decisions.
- The change ledger is read-only and contains original text, generated text, reason, evidence IDs/text, and one approved editing principle.
- Approved principles are `relevance_order`, `contribution_clarity`, `result_visibility`, `jd_vocabulary`, `concision`, and `structure`.
- Model-generated changes cannot add unsupported numbers, roles, skills, companies, projects, dates, or results. Existing “参与” wording cannot be escalated to “主导”.
- User edits are authoritative current text and are labelled as user edits; do not invent system reasoning for them.
- Preserve the source résumé and all historical drafts. Activation creates a new version and never overwrites source text.
- Activation and the new funnel strategy round succeed or roll back together. Repeating the same activation creates neither a second résumé version nor a second round.
- Do not export Word/PDF, change templates, access BOSS, or perform an external write in this plan.
- Add no dependency or new frontend framework.

---

## Task 1: Strengthen the Evidence-Grounded Change Contract

**Files:**

- Modify: `src/core/resume_optimization.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Modify: `tests/resume_optimization_contract_smoke.js`
- Modify: `tests/model_adapter_smoke.js`

**Interfaces:**

- Consumes: existing `buildResumeEvidenceCatalog`, exact-anchor patch validation, and model method `generateResumeOptimization(input)`.
- Produces:

```js
validateResumeOptimizationDraft(raw, { sourceText, evidenceCatalog })
// => { headline, suggestions: [{
//   id, operation, originalText, proposedText, reason,
//   evidenceIds, editingPrinciple, decision: "accepted", userText: ""
// }] }

renderOptimizedResume(sourceText, validatedSuggestions)
```

- [x] **Step 1: Add failing contract cases for editing principles and auto-application**

Extend `tests/resume_optimization_contract_smoke.js` with a valid change:

```js
const draft = validateResumeOptimizationDraft({
  headline: "让相关项目更容易被看见",
  suggestions: [{
    id: "S1",
    operation: "replace",
    originalText: "参与企业知识库开发",
    proposedText: "参与 Node.js 企业知识库开发",
    reason: "把已有技术栈放进相关项目描述",
    evidenceIds: ["R2", "R3", "J1"],
    editingPrinciple: "jd_vocabulary"
  }]
}, { sourceText, evidenceCatalog });
assert.equal(draft.suggestions[0].decision, "accepted");
assert.equal(draft.suggestions[0].editingPrinciple, "jd_vocabulary");
assert.match(renderOptimizedResume(sourceText, draft.suggestions), /Node\.js 企业知识库/);
```

Reject an unknown principle, unsupported number, overlapping anchor, missing evidence, and responsibility escalation. Confirm a rejected model result leaves the database untouched in the service test from Task 3.

- [x] **Step 2: Run the contract tests and verify failure**

```powershell
node tests/resume_optimization_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: failure because `editingPrinciple` is neither required nor returned and suggestions default to `pending`.

- [x] **Step 3: Add the finite principle contract**

In `src/core/resume_optimization.js`, add:

```js
const EDITING_PRINCIPLES = new Set([
  "relevance_order",
  "contribution_clarity",
  "result_visibility",
  "jd_vocabulary",
  "concision",
  "structure"
]);
```

Validate every `editingPrinciple` against this set and return validated suggestions with `decision: "accepted"`. Keep exact anchors, overlap rejection, cited-evidence checks, unsupported-number rejection, and strong-role-marker rejection unchanged. `renderOptimizedResume` must therefore produce the complete generated draft immediately.

- [x] **Step 4: Update real and mock adapter outputs**

Change the real prompt to require:

```text
{headline,suggestions:[{id,operation,originalText,proposedText,reason,evidenceIds,editingPrinciple}]}
```

State the six exact principle values, keep the 12-change maximum as an internal safety cap, and remove the instruction saying not to create a complete user-facing résumé; clarify that RoleFlow applies validated patches itself. The model still returns patches, not a free-form unvalidated whole document.

Make `MockModelAdapter.generateResumeOptimization` return `editingPrinciple: "structure"` for its deterministic change. Update `tests/model_adapter_smoke.js` to assert the new contract phrases and mock field.

- [x] **Step 5: Run the model and contract regressions**

```powershell
node tests/resume_optimization_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: both pass.

- [x] **Step 6: Commit the contract checkpoint**

```powershell
git add src/core/resume_optimization.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/resume_optimization_contract_smoke.js tests/model_adapter_smoke.js
git commit -m "feat: validate resume change principles"
```

---

## Task 2: Persist Generated Baseline, User Text, Direction, and Round Link

**Files:**

- Modify: `src/core/storage.js`
- Modify: `src/storage/resume_optimization_store.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/resume_optimization_store_smoke.js`

**Interfaces:**

- Consumes: migration 23 and round functions from `2026-08-29-funnel-strategy-rounds.md`.
- Produces:

```js
createResumeOptimization(db, {
  profileId, sourceResumeVersionId, targetDirection, targetJobIds,
  evidenceCatalog, headline, suggestions, generatedText, modelIdentity
})

saveResumeOptimizationDraft(db, {
  profileId, optimizationId, finalText, updatedAt
})

activateResumeOptimization(db, {
  profileId, planId, optimizationId, finalText, version
})
```

Mapped rows add `targetDirection`, `generatedText`, `changeLedger`, `draftFormat`, `userEditedAt`, and `strategyRoundId`. Keep `suggestions` as a compatibility alias of `changeLedger` until all older code paths are migrated.

- [x] **Step 1: Write failing storage and migration assertions**

Update `tests/resume_optimization_store_smoke.js` so a new draft is created with:

```js
assert.equal(draft.targetDirection, "AI 应用工程师");
assert.equal(draft.generatedText, generatedText);
assert.equal(draft.finalText, generatedText);
assert.equal(draft.draftFormat, "whole_draft");
assert.deepEqual(draft.changeLedger, changes);
```

Save a full edited string and assert only `final_text`, `user_edited_at`, and `updated_at` change; `source_text`, `generated_text`, evidence, and change ledger remain frozen. Add a v23 migration fixture and assert older rows become `draftFormat: "legacy_suggestions"`, keep their old suggestions, and remain readable.

- [x] **Step 2: Run the store and migration tests and verify failure**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: failure because v24 columns and whole-draft semantics do not exist.

- [x] **Step 3: Add migration 24**

Add migration:

```js
{
  version: 24,
  name: "resume_optimization_whole_draft_v2",
  apply(db) {
    migrateResumeOptimizationWholeDraft(db);
  }
}
```

Add columns:

```text
target_direction TEXT NOT NULL DEFAULT ''
generated_text TEXT NOT NULL DEFAULT ''
draft_format TEXT NOT NULL DEFAULT 'legacy_suggestions'
user_edited_at TEXT
strategy_round_id INTEGER REFERENCES candidate_funnel_strategy_rounds(id)
```

Update the fresh schema with the same columns. For existing activated rows, set `generated_text=final_text` when final text exists; do not rewrite source, final, evidence, or suggestions. New rows explicitly store `draft_format='whole_draft'`.

- [x] **Step 4: Implement immutable generated content and mutable user content**

`createResumeOptimization` validates non-empty `targetDirection` (160 characters), `generatedText`, 1–5 target jobs, and stores generated text into both `generated_text` and initial `final_text`. Rename mapped `suggestions_json` to the user-facing `changeLedger` while retaining `suggestions` as the same parsed array for old callers.

Change `saveResumeOptimizationDraft` to accept only the full `finalText` plus optional timestamp; reject blank or over-200,000-character text and closed drafts. Set `user_edited_at` only when normalized current text differs from `generated_text`.

- [x] **Step 5: Keep activation idempotent before adding the round boundary**

Accept `finalText` in `activateResumeOptimization` and, inside its existing immediate transaction, save that exact current text before creating the document/version. If the row is already activated, return it only when the repeated `finalText` equals the persisted final text; reject a late different text with `RESUME_OPTIMIZATION_CLOSED`.

Do not start a round in this step; Task 5 joins activation and round creation after the service/UI path is ready.

- [x] **Step 6: Run storage and migration regressions**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: pass with source preservation, full-text save, rollback, and retry idempotency.

- [x] **Step 7: Commit the storage checkpoint**

```powershell
git add src/core/storage.js src/storage/resume_optimization_store.js tests/storage_migration_smoke.js tests/resume_optimization_store_smoke.js
git commit -m "feat: persist complete resume drafts"
```

---

## Task 3: Select Representative JDs and Create the Complete Draft

**Files:**

- Modify: `src/core/resume_optimization.js`
- Modify: `src/application/resume_optimization/index.js`
- Modify: `tests/resume_optimization_service_smoke.js`

**Interfaces:**

- Consumes: whole-draft contract and storage from Tasks 1–2, `listDecisionPool(db, { planId })`, and `plan.plan.directions`.
- Produces:

```js
selectRepresentativeResumeJobs(jobs, { targetDirection, limit: 5 })
service.createDraft({ profileId, planId, sourceResumeVersionId, targetDirection })
service.saveDraft({ profileId, draftId, finalText })
service.activateDraft({ profileId, planId, draftId, finalText })
```

- [x] **Step 1: Replace user-selected job fixtures with direction-selection fixtures**

In `tests/resume_optimization_service_smoke.js`, seed six complete jobs and one incomplete job across repeated and distinct companies. Assert:

```js
const draft = await service.createDraft({
  profileId, planId, sourceResumeVersionId, targetDirection: "AI 应用工程师"
});
assert(draft.targetJobIds.length >= 3 && draft.targetJobIds.length <= 5);
assert.equal(new Set(selectedJobs.map((job) => job.company)).size, selectedJobs.length);
assert.match(draft.generatedText, /Node\.js/);
assert.equal(draft.finalText, draft.generatedText);
assert.equal(draft.changeLedger[0].editingPrinciple, "jd_vocabulary");
```

Assert incomplete JDs are never selected, a foreign direction is rejected, and no database row exists after model validation failure or when no complete matching JD is available.

- [x] **Step 2: Run the service test and verify failure**

```powershell
node tests/resume_optimization_service_smoke.js
```

Expected: failure because `createDraft` still requires explicit `jobIds` and leaves final text blank.

- [x] **Step 3: Implement deterministic representative selection**

Export `selectRepresentativeResumeJobs` from `src/core/resume_optimization.js`. Normalize the chosen direction and score complete jobs by:

1. direction tokens present in title/keyword/analysis role fields;
2. recommendation rank `primary`, `apply`, `caution`, then other;
3. `lastSeenAt` descending;
4. numeric job ID descending as the stable tie-break.

Take the best job from each non-empty company first, then fill remaining slots by rank, capped at five. Require the direction to be one of `plan.plan.directions`; do not silently combine directions.

- [x] **Step 4: Auto-apply validated changes in the service**

Change `createDraft` to accept `targetDirection`, select jobs internally, build the existing evidence catalog, call the adapter, validate the patches, and compute:

```js
const generatedText = renderOptimizedResume(source.text, validated.suggestions);
```

Persist `targetDirection`, selected IDs, immutable change ledger, `generatedText`, and the model identity in one insert after every validation succeeds. No draft row may be inserted before model/contract validation completes.

Change `saveDraft` to pass one full `finalText` to storage. Pass `planId` and current `finalText` through `activateDraft` for Task 5.

- [x] **Step 5: Expose directions and selected source jobs in the dashboard model**

Return:

```js
{
  directions: plan.plan?.directions || [],
  selectedJobs: selectedDraft ? rowsForJobIds(selectedDraft.targetJobIds) : [],
  ...existingDashboardFields
}
```

Do not return raw contact data or a hidden model prompt.

- [x] **Step 6: Run the service and model regressions**

```powershell
node tests/resume_optimization_service_smoke.js
node tests/resume_optimization_contract_smoke.js
node tests/model_adapter_smoke.js
```

Expected: all pass.

- [x] **Step 7: Commit complete draft generation**

```powershell
git add src/core/resume_optimization.js src/application/resume_optimization/index.js tests/resume_optimization_service_smoke.js
git commit -m "feat: generate complete targeted resumes"
```

---

## Task 4: Replace Per-Suggestion Approval with a Full Autosaved Editor

**Files:**

- Modify: `src/dashboard/pages/resume_optimization.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `tests/dashboard_resume_optimization_smoke.js`

**Interfaces:**

- Consumes: new service inputs and whole-draft row shape from Task 3.
- Produces: direction-based create form, `POST /api/resume-optimization/save` JSON/form save, and activation submission containing the editor's current `finalText`.

- [x] **Step 1: Write failing page, route, and race assertions**

Replace the old checkbox/radio assertions with:

```js
assert.match(page.body, /目标投递方向/);
assert.match(page.body, /本次参考岗位/);
assert.match(page.body, /完整简历草稿/);
assert.match(page.body, /name="finalText"/);
assert.match(page.body, /修改了什么/);
assert.match(page.body, /岗位用词对齐/);
assert.doesNotMatch(page.body, /decision_S1|userText_S1|接受建议|忽略建议/);
```

POST create with `targetDirection` and no job IDs; assert the service receives the new signature. POST JSON autosave with `finalText`; assert `{ok:true}`. POST activation with text typed after the latest autosave started; assert `activateDraft` receives the activation form's newer text, proving the click cannot activate stale content.

- [x] **Step 2: Run the Dashboard test and verify failure**

```powershell
node tests/dashboard_resume_optimization_smoke.js
```

Expected: failure on the old per-suggestion UI and old handler signatures.

- [x] **Step 3: Render source résumé plus direction selection**

Change the create form to show one source résumé selector and one required direction selector from `dashboard.directions`. Remove job checkboxes. Keep the no-model and no-complete-JD disabled states, with direct wording that a trusted complete JD is required.

- [x] **Step 4: Render the complete editor and read-only ledger**

For a `whole_draft` row, render one form containing the editable `textarea[name=finalText]`, explicit “保存草稿” fallback, a “复制当前全文” button, and an “启用为新版本” submit button using `formaction="/api/resume-optimization/activate"`. Resolve each change's `evidenceIds` against `evidenceCatalog` and render escaped excerpts plus the localized principle label. Show selected job title/company cards above the ledger. When `userEditedAt` is present, label the current full text “用户已修改”; keep the ledger explicitly tied to the system-generated baseline instead of inventing explanations for user edits.

For `legacy_suggestions`, keep a read-only historical view; do not make users complete the retired per-item flow.

- [x] **Step 5: Add serialized 600 ms autosave**

Replace per-suggestion JavaScript with one serialized write chain:

```js
const save = (text) => fetch("/api/resume-optimization/save", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ planId, draftId, finalText: text })
});
```

Debounce input by 600 ms, never run two saves concurrently, display saved/failed state, and leave the textarea content untouched after an error. The activation form submits its current textarea value directly; it does not wait for or trust an older autosave response.

- [x] **Step 6: Update handlers for full text**

Create handler input becomes:

```js
{
  profileId: plan.profileId,
  planId: plan.id,
  sourceResumeVersionId: Number(params.sourceResumeVersionId),
  targetDirection: params.targetDirection
}
```

Save passes `{ profileId, draftId, finalText }`; return JSON for JSON requests and retain redirect fallback for normal forms. Activation passes `{ profileId, planId, draftId, finalText }`. Keep ownership checks and 404 behavior.

- [x] **Step 7: Add minimal existing-style layout rules**

Reuse the current cards and typography. Add only full-editor, save-status, selected-job, and change-ledger rules; keep labels associated with controls, visible focus, and mobile single-column behavior.

- [x] **Step 8: Run Dashboard regressions**

```powershell
node tests/dashboard_resume_optimization_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/dashboard_shell_smoke.js
```

Expected: all pass.

- [x] **Step 9: Commit the full-editor flow**

```powershell
git add src/dashboard/pages/resume_optimization.js src/dashboard/server.js src/dashboard/assets/roleflow.css tests/dashboard_resume_optimization_smoke.js
git commit -m "feat: edit complete resume drafts"
```

---

## Task 5: Make Résumé Activation and Strategy-Round Creation Atomic

**Files:**

- Modify: `src/storage/resume_optimization_store.js`
- Modify: `src/application/resume_optimization/index.js`
- Modify: `tests/resume_optimization_store_smoke.js`
- Modify: `tests/resume_optimization_service_smoke.js`

**Interfaces:**

- Consumes: `getActiveFunnelStrategyRound`, `startFunnelStrategyRound`, and transaction-aware round storage from stage two.
- Produces: an activated optimization row whose `strategyRoundId` identifies the single round created by `sourceKey: resume_optimization:<optimizationId>`.

- [x] **Step 1: Add failing atomicity and idempotency tests**

In the store test, activate with `planId` and current full text, then assert:

```js
assert.equal(activated.strategyRoundId, activeRound.id);
assert.deepEqual(activeRound.changeKinds, ["resume"]);
assert.equal(activeRound.resumeVersionId, activated.resultResumeVersionId);
assert.equal(activeRound.sourceKey, `resume_optimization:${draft.id}`);
```

Repeat activation and assert document/version/round counts do not change. Install a trigger that fails round insertion; assert document insertion, version insertion, optimization status, current full text, and previous active round closure all roll back together.

- [x] **Step 2: Run the focused tests and verify failure**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
```

Expected: failure because activation does not yet create or store a strategy round.

- [x] **Step 3: Start the round inside the activation transaction**

After creating the new résumé version but before marking the optimization activated:

```js
const fromRound = getActiveFunnelStrategyRound(db, { profileId, planId });
const strategyRound = startFunnelStrategyRound(db, {
  profileId,
  planId,
  fromRoundId: fromRound?.id || null,
  sourceKey: `resume_optimization:${optimizationId}`,
  changeKinds: ["resume"],
  changeNote: "启用定向简历",
  resumeVersionId: versionId,
  startedAt: now
});
```

Persist `strategy_round_id` on the optimization update. Both round functions must detect `db.isTransaction` and avoid nesting `BEGIN`. If no previous active round exists, this becomes sequence 1 rather than creating an empty initial round first.

- [x] **Step 4: Pass the owned plan through the service**

In `activateDraft`, validate the plan belongs to the profile and pass `planId` to storage. Name/target role metadata derives from frozen selected jobs and `targetDirection`; never recalculate target jobs during activation.

- [x] **Step 5: Run atomic activation regressions**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/funnel_strategy_round_store_smoke.js
node tests/funnel_diagnosis_smoke.js
```

Expected: all pass, including forced rollback and duplicate activation.

- [x] **Step 6: Commit the cross-stage boundary**

```powershell
git add src/storage/resume_optimization_store.js src/application/resume_optimization/index.js tests/resume_optimization_store_smoke.js tests/resume_optimization_service_smoke.js
git commit -m "feat: start funnel round on resume activation"
```

---

## Task 6: Final Stage-Three Verification and Documentation

**Files:**

- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-29-whole-draft-resume-optimization.md`

**Interfaces:**

- Consumes: all stage-three tasks.
- Produces: verified whole-draft résumé checkpoint and explicit stage-four entry.

- [x] **Step 1: Run focused stage-three checks**

```powershell
node tests/storage_migration_smoke.js
node tests/resume_optimization_contract_smoke.js
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/dashboard_resume_optimization_smoke.js
node tests/model_adapter_smoke.js
node tests/funnel_strategy_round_store_smoke.js
node tests/funnel_diagnosis_smoke.js
```

Expected: all pass.

- [x] **Step 2: Run the complete offline gate**

```powershell
npm test
```

Expected: a fresh `All <current count> offline checks passed.` result.

- [x] **Step 3: Update handoff and next-phase documents**

Record the complete draft/editor flow, selected JD evidence, immutable change ledger, activation/round transaction, actual test count, and that no real BOSS or user résumé was accessed. Set the next entry to résumé-general mock interview; do not claim it is implemented.

- [x] **Step 4: Check plan completion and repository hygiene**

```powershell
rg -n "^- \[ \]" docs/superpowers/plans/2026-08-29-whole-draft-resume-optimization.md
git diff --check
git status --short
```

Expected: no unchecked step or whitespace error and only intended documentation changes remain.

- [x] **Step 5: Commit the stage-three closeout**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-29-whole-draft-resume-optimization.md
git commit -m "docs: close complete resume draft stage"
```

- [x] **Step 6: Verify the exact final commit**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/dashboard_resume_optimization_smoke.js
git diff --check HEAD^
git status --short --branch
git rev-parse HEAD
```

Expected: focused tests pass and worktree is clean. Do not push, merge, package, change the application version, or create a release without a new explicit user request.
