# Contextual Mock Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stage-four text interview loop that can start from any complete local job, asks dynamic follow-ups grounded in the bound JD/resume and latest answer, saves history, produces evidence-linked review, and lets the user retry weak answers.

**Architecture:** A pure interview contract validates settings, questions, per-answer reviews, and final reports. A SQLite store freezes the selected job/resume context and appends turns/retries. An application service coordinates the existing deep-analysis model adapter; a server-rendered Dashboard page provides start, answer, finish, history, report, and retry flows.

**Tech Stack:** Node.js 22 CommonJS, built-in SQLite, existing OpenAI-compatible and Mock adapters, server-rendered HTML/CSS, assert-based smoke tests.

## Global Constraints

- Use the approved `2026-08-28-contextual-mock-interview-design.md` contract.
- A real interview invitation is optional; any owned job with complete JD and an owned active resume may start practice.
- Freeze the job and resume identity for each session so later changes cannot silently switch context.
- Questions must use the selected JD/resume; follow-ups must use the immediately preceding answer.
- Reviews must point to concrete turn numbers and must not present a total score as an offer probability.
- Practice answers and model examples remain interview history and must never become candidate facts or answer memories automatically.
- Preserve completed answers when a model call fails; do not create a half-complete final report.
- Reuse `deep_analysis`; do not add a model task profile, LangGraph, LiveKit, STT/TTS, a question-bank service, or a new dependency.
- Do not access BOSS, perform an external write, push, merge, package, change the version, or create a release.

---

### Task 1: Record the reuse decision

**Files:**
- Create: `docs/superpowers/reports/2026-08-29-stage4-mock-interview-reuse.md`

**Interfaces:**
- Produces a durable `reference_only` decision for Interview Coach and DeepInterview.

- [x] **Step 1: Review official sources and existing RoleFlow context**

Keep only the preparation/live/review split, local history, and weakness-focused follow-up ideas.

- [x] **Step 2: Check the report**

```powershell
rg -n "TBD|TODO|placeholder" docs/superpowers/reports/2026-08-29-stage4-mock-interview-reuse.md
```

Expected: no unfinished marker.

- [x] **Step 3: Commit the stage-four plan and research record**

```powershell
git add docs/superpowers/reports/2026-08-29-stage4-mock-interview-reuse.md docs/superpowers/plans/2026-08-29-contextual-mock-interview.md
git commit -m "docs: plan contextual mock interview"
```

### Task 2: Define the interview contract

**Files:**
- Create: `src/core/mock_interview.js`
- Create: `tests/mock_interview_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `normalizeInterviewSettings`, `validateInterviewStep`, `validateInterviewReport`, and `validateRetryReview`.
- Interview step shape: `{answerReview, nextQuestion, complete}`; report references turn numbers rather than free-floating quotes.

- [x] **Step 1: Write a failing contract test**

Prove that invalid type/difficulty/length is rejected, a first step cannot contain an answer review, a follow-up without the previous turn reference is rejected, a completed step cannot also contain a next question, report turn references must exist, and “offer probability” fields are rejected.

- [x] **Step 2: Run and verify RED**

Run: `node tests/mock_interview_contract_smoke.js`

Expected: fail because the core module does not exist.

- [x] **Step 3: Implement the smallest validator**

Allow `general`, `technical`, `behavioral`, and `mixed`; `warmup`, `standard`, and `challenging`; 3–12 planned questions. Bound all arrays and text. Preserve qualitative dimensions instead of manufacturing a scalar readiness score.

- [x] **Step 4: Run the contract test**

Run: `node tests/mock_interview_contract_smoke.js`

Expected: pass.

- [x] **Step 5: Commit**

```powershell
git add src/core/mock_interview.js tests/mock_interview_contract_smoke.js tests/run_all.js
git commit -m "feat: define contextual interview contract"
```

### Task 3: Persist sessions, turns, reports, and retries

**Files:**
- Create: `src/storage/mock_interview_store.js`
- Modify: `src/core/storage.js`
- Create: `tests/mock_interview_store_smoke.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Migration 20 creates `mock_interview_sessions`, `mock_interview_turns`, and `mock_interview_retries`.
- Produces: `createMockInterviewSession`, `getMockInterviewSession`, `listMockInterviewSessions`, `appendMockInterviewQuestion`, `answerMockInterviewTurn`, `completeMockInterviewSession`, `recordMockInterviewRetry`.

- [x] **Step 1: Write failing store tests**

Prove profile ownership, frozen context hash, monotonic turn ordering, one answer per question, completed-session immutability except retry records, failed report rollback, and retry linkage to an owned answered turn.

- [x] **Step 2: Run and verify RED**

```powershell
node tests/mock_interview_store_smoke.js
node tests/storage_migration_smoke.js
```

Expected: fail for missing migration/store.

- [x] **Step 3: Add migration 20 and store**

Store the frozen local context JSON with the session because jobs may refresh later. Never log it. Keep append/update operations in `BEGIN IMMEDIATE` transactions and make identical answer retries idempotent.

- [x] **Step 4: Run storage gates**

```powershell
node tests/mock_interview_store_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
node tests/message_learning_store_smoke.js
```

- [x] **Step 5: Commit**

```powershell
git add src/storage/mock_interview_store.js src/core/storage.js tests/mock_interview_store_smoke.js tests/storage_migration_smoke.js tests/candidate_store_contract_smoke.js tests/run_all.js
git commit -m "feat: persist mock interview sessions"
```

### Task 4: Implement dynamic question, review, and retry services

**Files:**
- Create: `src/application/mock_interview/index.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/adapters/models/mock.js`
- Create: `tests/mock_interview_service_smoke.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Service methods: `startSession`, `answerTurn`, `finishSession`, `retryTurn`, `getSession`, `listSessions`, `dashboard`.
- Adapter methods: `generateMockInterviewStep`, `reviewMockInterview`, `reviewMockInterviewRetry`.

- [x] **Step 1: Write the failing service test**

Use real SQLite and a scripted adapter. Prove the initial prompt contains the frozen job/resume, the second call contains the literal previous answer, the service does not advance when the model step is invalid, the final report references only existing turns, a model failure preserves prior answers, and no candidate fact/memory row is inserted.

- [x] **Step 2: Run and verify RED**

Run: `node tests/mock_interview_service_smoke.js`

Expected: fail because the service does not exist.

- [x] **Step 3: Implement service and adapters**

Use one model call per answer to review it and select the next question; after the final answer use one separate report call. The Mock adapter must generate deterministic role-specific questions and a follow-up that visibly depends on the previous answer.

- [x] **Step 4: Run focused tests**

```powershell
node tests/mock_interview_service_smoke.js
node tests/model_adapter_smoke.js
node tests/profile_quality_smoke.js
node tests/resume_optimization_service_smoke.js
```

- [x] **Step 5: Commit**

```powershell
git add src/application/mock_interview/index.js src/adapters/models/openai_compatible.js src/adapters/models/mock.js tests/mock_interview_service_smoke.js tests/model_adapter_smoke.js tests/run_all.js
git commit -m "feat: add dynamic mock interview service"
```

### Task 5: Add the interview Dashboard

**Files:**
- Create: `src/dashboard/pages/mock_interview.js`
- Modify: `src/dashboard/ui/navigation.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/roleflow.css` only if necessary.
- Create: `tests/dashboard_mock_interview_smoke.js`
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Routes: `GET /interview`, `POST /api/interview/start`, `POST /api/interview/answer`, `POST /api/interview/finish`, `POST /api/interview/retry`.

- [ ] **Step 1: Write a failing HTTP test**

Prove a user can start without an invitation, the page shows the bound job/resume, each form carries owned IDs, answer text is escaped, completed reports show conclusion/strengths/improvements/retry controls before the transcript, and retry comparison shows both answers.

- [ ] **Step 2: Run and verify RED**

Run: `node tests/dashboard_mock_interview_smoke.js`

Expected: 404 or missing page module.

- [ ] **Step 3: Implement routes and page**

The page must remain a local text workflow and must not check browser readiness. Use a single answer form per current question. Disable duplicate submission in the existing lightweight script style; preserve browser back/refresh idempotence.

- [ ] **Step 4: Run HTTP and shell tests**

```powershell
node tests/dashboard_mock_interview_smoke.js
node tests/dashboard_shell_smoke.js
node tests/dashboard_resume_optimization_smoke.js
```

- [ ] **Step 5: Commit**

```powershell
git add src/dashboard/pages/mock_interview.js src/dashboard/ui/navigation.js src/dashboard/server.js src/dashboard/assets/roleflow.css tests/dashboard_mock_interview_smoke.js tests/dashboard_shell_smoke.js tests/run_all.js
git commit -m "feat: add mock interview workspace"
```

### Task 6: Verify stage four and close both stages

**Files:**
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-29-contextual-mock-interview.md`
- Modify: `docs/superpowers/plans/2026-08-29-targeted-resume-optimization.md`

**Interfaces:**
- Produces exact final SHA and the next evidence-dependent product entry.

- [ ] **Step 1: Run focused stage-four and cross-stage checks**

```powershell
node tests/mock_interview_contract_smoke.js
node tests/mock_interview_store_smoke.js
node tests/mock_interview_service_smoke.js
node tests/dashboard_mock_interview_smoke.js
node tests/resume_optimization_store_smoke.js
node tests/dashboard_resume_optimization_smoke.js
node tests/dashboard_funnel_smoke.js
node tests/message_learning_store_smoke.js
```

- [ ] **Step 2: Run local desktop/mobile visual verification**

Use the local fixture at 1440px and 390px. Verify no horizontal overflow, question/answer focus order, readable report hierarchy, keyboard access, and no console error.

- [ ] **Step 3: Request independent read-only review**

Review correctness, architecture, privacy, cross-profile ownership, model-contract boundaries, idempotence, and unnecessary complexity. Fix every Critical/Important finding with a failing regression first.

- [ ] **Step 4: Run the complete gate**

```powershell
npm test
git diff --check
git status --short --branch
```

Record the actual check count from this run; do not reuse the earlier 116 total.

- [ ] **Step 5: Update handoff documents and commit**

Document user-visible behavior, implementation commits, verification, synthetic-only evidence, no real BOSS access, no external write, and remaining unverified model/natural-effect assumptions.

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-29-contextual-mock-interview.md docs/superpowers/plans/2026-08-29-targeted-resume-optimization.md
git commit -m "docs: close resume and interview stages"
```

- [ ] **Step 6: Verify the exact final SHA**

```powershell
node tests/dashboard_resume_optimization_smoke.js
node tests/dashboard_mock_interview_smoke.js
node tests/storage_migration_smoke.js
node tests/message_learning_store_smoke.js
git diff --check HEAD^
git status --short --branch
git rev-parse HEAD
```

Do not claim real resume conversion improvement or real interview quality without natural user/model evidence.
