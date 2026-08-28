# Targeted Resume Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, evidence-grounded workflow that turns one existing resume and one to five similar target jobs into an editable draft and activates it as a new resume version without overwriting the source.

**Architecture:** A pure core module owns evidence catalog construction, model-output validation, and deterministic text application. A SQLite store owns immutable source identity, editable suggestions, and atomic activation. An application service loads existing RoleFlow data and calls the existing deep-analysis model adapter; a server-rendered Dashboard page provides create, edit, ignore, accept, copy, and activate actions.

**Tech Stack:** Node.js 22 CommonJS, built-in SQLite, existing OpenAI-compatible and Mock adapters, server-rendered HTML/CSS, assert-based smoke tests.

## Global Constraints

- Use the approved `2026-08-28-targeted-resume-optimization-design.md` contract.
- Reuse the existing candidate profile, candidate facts, answer memories, jobs, analyses, resume versions, model settings, Dashboard shell, and funnel binding.
- Never overwrite a source resume document or source resume version.
- Default to one target job and allow at most five jobs only when the user explicitly selects a similar group.
- Model suggestions must cite evidence IDs. New model-authored numbers must occur in cited evidence, and a source limited to participation/support must not become leadership/full ownership.
- User edits are authoritative local input and do not require a second confirmation.
- Activating a draft creates exactly one new resume document and version in the same SQLite transaction; retries are idempotent.
- A model or external-capability failure must not activate a partial version.
- Do not add dependencies, a second database, a front-end framework, an ORM, a queue, or a new model task profile.
- Do not access BOSS, perform an external write, push, merge, package, change the version, or create a release.

---

### Task 1: Record the reuse decision

**Files:**
- Create: `docs/superpowers/reports/2026-08-29-stage3-resume-optimization-reuse.md`

**Interfaces:**
- Consumes: the approved design and current official project documentation.
- Produces: a durable `reference_only` decision that forbids importing another resume platform.

- [x] **Step 1: Review official sources and current RoleFlow capabilities**

Confirm that Resume Matcher and Reactive Resume provide useful interaction ideas but would duplicate RoleFlow storage, UI, and model configuration.

- [x] **Step 2: Write the report and inspect it for unsupported claims**

Run:

```powershell
rg -n "TBD|TODO|placeholder" docs/superpowers/reports/2026-08-29-stage3-resume-optimization-reuse.md
```

Expected: no unfinished marker.

- [x] **Step 3: Commit**

```powershell
git add docs/superpowers/reports/2026-08-29-stage3-resume-optimization-reuse.md docs/superpowers/plans/2026-08-29-targeted-resume-optimization.md
git commit -m "docs: plan targeted resume optimization"
```

### Task 2: Define evidence-grounded text operations

**Files:**
- Create: `src/core/resume_optimization.js`
- Create: `tests/resume_optimization_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `buildResumeEvidenceCatalog(input)`, `validateResumeOptimizationDraft(raw, context)`, `normalizeResumeSuggestionDecisions(suggestions, input)`, and `renderOptimizedResume(sourceText, suggestions)`.
- Suggestion shape: `{id, operation, originalText, proposedText, reason, evidenceIds, decision, userText}`.

- [x] **Step 1: Write the failing core contract test**

Cover these observable breaks:

```js
assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1", operation: "replace", originalText: "不存在的原文",
  proposedText: "改写", reason: "对齐岗位", evidenceIds: ["R1"]
}]}, context), /原文/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1", operation: "replace", originalText: "参与知识库开发",
  proposedText: "主导知识库开发，提升 80%", reason: "强化贡献", evidenceIds: ["R1"]
}]}, context), /职责边界|数字/);
```

Also prove that accepted, edited, and ignored operations produce the literal expected final resume, and overlapping anchors are rejected.

- [x] **Step 2: Run the test and verify RED**

Run: `node tests/resume_optimization_contract_smoke.js`

Expected: fail because `src/core/resume_optimization.js` does not exist.

- [x] **Step 3: Implement the minimal core module**

Evidence IDs are deterministic within one draft. Validate exact unique anchors, non-overlapping source ranges, supported operations (`replace`, `remove`, `insert_after`), referenced evidence existence, new numeric tokens, and role-boundary escalation. Apply accepted edits from the end of the source text toward the beginning so offsets remain stable.

- [x] **Step 4: Run the focused test and existing privacy test**

```powershell
node tests/resume_optimization_contract_smoke.js
node tests/resume_privacy_smoke.js
```

Expected: both print `ok` and exit 0.

- [x] **Step 5: Commit**

```powershell
git add src/core/resume_optimization.js tests/resume_optimization_contract_smoke.js tests/run_all.js
git commit -m "feat: validate grounded resume edits"
```

### Task 3: Persist drafts and atomically activate versions

**Files:**
- Create: `src/storage/resume_optimization_store.js`
- Modify: `src/core/storage.js`
- Create: `tests/resume_optimization_store_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `createResumeOptimization`, `getResumeOptimization`, `listResumeOptimizations`, `saveResumeOptimizationDraft`, `activateResumeOptimization`.
- Migration 19 creates `resume_optimizations` with profile/source/job ownership, evidence and suggestion JSON, source hash, final text, result version, status, model identity, and timestamps.

- [x] **Step 1: Write failing migration and store tests**

Prove that another profile cannot read or update a draft, source text/hash are frozen, late save after activation is rejected, activation creates a distinct document/version, the source stays unchanged, and the same activation retried returns the same version ID.

- [x] **Step 2: Run the tests and verify RED**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: fail for missing schema/store API and migration 19.

- [x] **Step 3: Add migration 19 and the minimal store**

Use `BEGIN IMMEDIATE` for activation. Insert a text resume document with a SHA-256 content hash and a version key derived from the optimization ID. Save provenance in `analysis_json`; update the draft only after both inserts succeed.

- [x] **Step 4: Run focused storage gates**

```powershell
node tests/resume_optimization_store_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
node tests/funnel_diagnosis_smoke.js
```

Expected: all pass.

- [x] **Step 5: Commit**

```powershell
git add src/storage/resume_optimization_store.js src/core/storage.js tests/resume_optimization_store_smoke.js tests/storage_migration_smoke.js tests/candidate_store_contract_smoke.js tests/run_all.js
git commit -m "feat: persist resume optimization drafts"
```

### Task 4: Generate drafts from existing RoleFlow context

**Files:**
- Create: `src/application/resume_optimization/index.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Create: `tests/resume_optimization_service_smoke.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces service methods `createDraft`, `getDraft`, `listDrafts`, `saveDraft`, `activateDraft`, and `dashboard`.
- Adds adapter method `generateResumeOptimization(input)` using the existing `deep_analysis` model configuration.

- [ ] **Step 1: Write a failing real-SQLite service test**

The test must create two profiles, one source resume, owned/unowned jobs, current facts and answer memories. It must prove only owned complete jobs are accepted, the adapter receives the exact selected version/JD/evidence catalog, malformed model output creates no draft, and successful output is normalized before persistence.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/resume_optimization_service_smoke.js`

Expected: fail because the application service does not exist.

- [ ] **Step 3: Implement the service and adapters**

The OpenAI-compatible prompt requests one headline plus at most twelve exact text operations with evidence IDs and no fabricated metrics. The Mock adapter returns deterministic, source-anchored edits. The service performs all ownership and contract checks; the adapter never writes storage.

- [ ] **Step 4: Run focused service/model tests**

```powershell
node tests/resume_optimization_service_smoke.js
node tests/model_adapter_smoke.js
node tests/profile_quality_smoke.js
node tests/message_learning_store_smoke.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add src/application/resume_optimization/index.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/resume_optimization_service_smoke.js tests/model_adapter_smoke.js tests/run_all.js
git commit -m "feat: generate targeted resume drafts"
```

### Task 5: Add the resume optimization Dashboard

**Files:**
- Create: `src/dashboard/pages/resume_optimization.js`
- Modify: `src/dashboard/ui/navigation.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/roleflow.css` only if existing classes cannot express the page.
- Create: `tests/dashboard_resume_optimization_smoke.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Routes: `GET /resume-optimization`, `POST /api/resume-optimization`, `POST /api/resume-optimization/save`, `POST /api/resume-optimization/activate`.
- The page receives plain view data; it does not query SQLite itself.

- [ ] **Step 1: Write a failing HTTP test**

Use a real local HTTP server with an injected service. Prove the page derives profile from `planId`, shows resume/job selectors, escapes model/user text, exposes accept/edit/ignore controls, redirects to the owned draft, and activation calls the service exactly once without a second confirmation page.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/dashboard_resume_optimization_smoke.js`

Expected: 404 or missing page module.

- [ ] **Step 3: Implement routes and page**

Keep the main order: conclusion, target/source identity, editable suggestions, resulting full text, version history. Copy stays local. Model-unavailable errors link to the existing model settings page. Do not add browser-runtime checks because this workflow is local.

- [ ] **Step 4: Run HTTP and shell regressions**

```powershell
node tests/dashboard_resume_optimization_smoke.js
node tests/dashboard_shell_smoke.js
node tests/dashboard_funnel_smoke.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add src/dashboard/pages/resume_optimization.js src/dashboard/ui/navigation.js src/dashboard/server.js src/dashboard/assets/roleflow.css tests/dashboard_resume_optimization_smoke.js tests/dashboard_shell_smoke.js tests/run_all.js
git commit -m "feat: add targeted resume workspace"
```

### Task 6: Verify stage three and update its acceptance record

**Files:**
- Modify: `docs/superpowers/plans/2026-08-29-targeted-resume-optimization.md`

**Interfaces:**
- Consumes all stage-three outputs.
- Produces exact code SHA and verification evidence before stage four begins.

- [ ] **Step 1: Run focused stage-three checks**

```powershell
node tests/resume_optimization_contract_smoke.js
node tests/resume_optimization_store_smoke.js
node tests/resume_optimization_service_smoke.js
node tests/dashboard_resume_optimization_smoke.js
node tests/storage_migration_smoke.js
node tests/dashboard_funnel_smoke.js
node tests/message_learning_store_smoke.js
```

- [ ] **Step 2: Run local desktop/mobile visual verification**

Use the bundled headless Edge/Playwright only against the local Dashboard fixture. Verify 1440px and 390px widths, no horizontal overflow, useful reading order, keyboard-reachable form controls, and no console error.

- [ ] **Step 3: Run repository gates**

```powershell
npm test
git diff --check
git status --short --branch
git rev-parse HEAD
```

- [ ] **Step 4: Commit the stage-three acceptance note**

```powershell
git add docs/superpowers/plans/2026-08-29-targeted-resume-optimization.md
git commit -m "docs: record targeted resume verification"
```

Do not claim natural conversion improvement: fixture and Mock checks prove mechanism only.
