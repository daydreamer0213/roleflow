# Live Model Stability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the strict generic-evidence pipeline diagnosable and stable enough for a fresh private full-chain comparison without weakening evidence or blocker rules.

**Architecture:** The OpenAI-compatible adapter classifies response failures without retaining content. The shared semantic pipeline attaches stage/phase metadata and closes the missing-indispensable blocker invariant. The private runner records only safe fields and executes model work serially under a new harness version.

**Tech Stack:** Node.js 22, `node:test`-style assertion smoke scripts, built-in `fetch`, `node:crypto`, `node:sqlite`, Git worktrees.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` and a separately prepared baseline worktree.
- Do not access BOSS, perform browser actions, touch `D:\Guo\ZhiPing\data\jobs.sqlite`, or start port 8787.
- Do not print or copy the formal model endpoint, key, settings content, resume text, JD text, company names, job URLs, or raw model output.
- Do not change the confirmed profile, matching card, 20 frozen jobs, or confirmed labels.
- Do not merge unless a fresh comparison returns `accepted=true`.
- Every production change follows red-green TDD.

---

### Task 1: Stable OpenAI-compatible response failures

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`

**Interfaces:**
- Produces: safe errors with `code`, `finishReason`, `contentLength`, `providerRequestId`, `httpStatus`, and `retryable`.
- Preserves: existing JSON-mode fallback, timeout normalization, and retry limits.

- [ ] **Step 1: Write failing adapter tests**

Add server responses for:

```js
{ choices: [{ finish_reason: "length", message: { content: "{\"partial\":" } }] }
```

and for an HTTP 200 body that is not JSON, a JSON body with no message content, and message content that is not valid JSON. Assert the respective codes:

```js
MODEL_OUTPUT_TRUNCATED
MODEL_INVALID_RESPONSE
MODEL_INVALID_RESPONSE
MODEL_INVALID_JSON
```

Assert logger metadata does not contain the response sentinel text.

- [ ] **Step 2: Verify red**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: fail because current code emits `model_invalid_json` or an unclassified error.

- [ ] **Step 3: Implement minimal classification**

In `requestJson`, parse the HTTP envelope in a guarded block, read `finish_reason`, and classify missing content before `parseJsonContent`. Change `invalidJson()` to use `MODEL_INVALID_JSON` and keep it retryable through the existing retry loop. Never log or attach raw content.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/model_parser_resilience_smoke.js
```

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/models/openai_compatible.js tests/model_adapter_smoke.js
git commit -m "fix: classify structured model response failures"
```

---

### Task 2: Close the hard-blocker contract

**Files:**
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/model_contract.js`

**Interfaces:**
- Consumes: normalized `requirementMatches` and structured `hardBlockers`.
- Produces: `MODEL_CONTRACT_INVALID` when an indispensable missing requirement lacks a same-name `indispensable_core` blocker.

- [ ] **Step 1: Write the failing contract test**

Create a synthetic `matchJob` result containing:

```js
requirementMatches: [{
  requirement: "核心平台开发",
  state: "missing",
  indispensable: true,
  jdEvidence: "",
  resumeEvidence: ""
}],
hardBlockers: [],
recommendation: "caution"
```

Assert validation throws `MODEL_CONTRACT_INVALID`. Add a repaired result with a complete structured blocker and `recommendation="skip"` and assert it passes.

- [ ] **Step 2: Verify red**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: the missing blocker case is currently accepted.

- [ ] **Step 3: Implement the reverse invariant**

After existing blocker-to-requirement validation, iterate over `requirementMatches` where `indispensable && state === "missing"` and require one exact `indispensable_core` blocker. Do not infer blockers for `unknown`, `transferable`, non-core requirements, experience preferences, or user notes.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
```

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add src/core/model_contract.js tests/semantic_pipeline_smoke.js
git commit -m "fix: require blockers for missing indispensable requirements"
```

---

### Task 3: Preserve safe failure stage and phase

**Files:**
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/job_analysis.js`
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify: `scripts/private-full-chain-runner.js`

**Interfaces:**
- Produces from `cachedModelCall`: thrown errors with `modelStage` and `modelPhase`.
- Produces in failed analysis: `errorStage`, `errorPhase`, stable `errorCode`.
- Produces in private rows: safe `failureStage` and `failurePhase`.

- [ ] **Step 1: Write failing injected-adapter tests**

Inject separate errors from `understandJob`, `matchJob`, and contract repair. Assert:

```js
analysis.errorStage === "understandJob" // or "matchJob"
analysis.errorPhase === "initial"       // or "contract_repair"
```

Add private-runner tests that preserve the three new stable adapter codes instead of converting them to `MODEL_ANALYSIS_FAILED`.

- [ ] **Step 2: Verify red**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: stage/phase fields are missing and new codes are collapsed.

- [ ] **Step 3: Implement minimal propagation**

Before rethrowing in `cachedModelCall`, set only:

```js
error.modelStage = kind;
error.modelPhase = "initial"; // or "contract_repair"
```

Copy these through `failedAnalysis`. Extend the private runner safe-code set and row projection. Do not persist error messages or raw outputs.

- [ ] **Step 4: Bump the private harness**

Change:

```js
private-full-chain-harness.v1
```

to:

```js
private-full-chain-harness.v2
```

Update exact test assertions. The existing v3 result remains historical evidence and is not rewritten.

- [ ] **Step 5: Verify green**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: both pass and output contains no private text.

- [ ] **Step 6: Commit**

```powershell
git add src/core/job_analysis.js scripts/private-full-chain-runner.js tests/semantic_pipeline_smoke.js tests/private_full_chain_runner_smoke.js
git commit -m "fix: preserve safe model failure provenance"
```

---

### Task 4: Bound output and serialize semantic analysis

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/product_policy.js`
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify: `scripts/private-full-chain-runner.js`

**Interfaces:**
- Prompt contract: every evidence excerpt at most 120 characters; requirement coverage remains complete.
- Product policy: `PRODUCT_POLICY.operations.modelAnalysis.scanConcurrency === 1`.
- Private harness: calls `mapWithConcurrency(fixture.jobs, 1, ...)`.

- [ ] **Step 1: Write failing prompt and pacing tests**

Assert both prompts contain the 120-character evidence bound and explicit array limits. Assert product policy and private-runner injected concurrency are one.

- [ ] **Step 2: Verify red**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: prompt-bound and concurrency assertions fail.

- [ ] **Step 3: Implement bounded prompts and pacing**

Add concise output-limit lines without removing five-state coverage, dual evidence, job quality, or blocker rules. Change only the two concurrency constants from three to one; do not reduce jobs, JD length, or retry coverage.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/private_full_chain_runner_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/models/openai_compatible.js src/core/product_policy.js scripts/private-full-chain-runner.js tests/model_adapter_smoke.js tests/private_full_chain_runner_smoke.js
git commit -m "fix: bound and serialize semantic model analysis"
```

---

### Task 5: Offline verification and private v4 package

**Files:**
- Private only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v4-20260726\`
- Baseline worktree: a new clean branch whose sole parent is `fb0168afce265cf351f03e80f66d9e0f24015887`

**Interfaces:**
- Reuses the exact v3 confirmed profile/card, jobs, labels, resume, and identity hashes.
- Shares the v2 private runner and helpers byte-for-byte between baseline and candidate.

- [ ] **Step 1: Run all offline verification**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/private_full_chain_runner_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: 47 checks pass and the candidate is clean after commits.

- [ ] **Step 2: Prepare a new single-parent baseline**

Create a new branch from the approved baseline product commit. Copy only the shared private runner files from the candidate and commit once. Verify `rev-list --parents -1` has exactly the approved product commit as its sole parent and shared Git blob IDs match.

- [ ] **Step 3: Create the v4 private package**

Copy v3 frozen inputs and labels mechanically, verify SHA-256 identity, initialize a new manifest bound to the new baseline and candidate evaluated commits, and create fresh empty baseline/candidate output directories.

- [ ] **Step 4: Stop before live calls if any identity differs**

The bundle verifier must pass before model configuration is resolved. Any mismatch blocks live execution and must not be repaired by editing the confirmed inputs.

---

### Task 6: Fresh serial live comparison

**Files:**
- Private: `full-chain-v4-20260726\runs\baseline\match-result.json`
- Private: `full-chain-v4-20260726\runs\candidate\match-result.json`
- Private: `full-chain-v4-20260726\reports\full-chain-compare.json`

- [ ] **Step 1: Run baseline and candidate serially**

Use the existing user authorizations in this continuous execution window, the read-only settings root `D:\Guo\ZhiPing`, separate fresh SQLite caches, and the exact same v4 harness and model identity. Never run both sides concurrently.

- [ ] **Step 2: Compare offline**

Remove live authorization environment variables before invoking compare mode. The comparator must derive all metrics from rows and must not call the model.

- [ ] **Step 3: Apply the gate**

If `accepted=true`, run the final offline suite once more and report the branch as eligible for integration review. If `accepted=false`, preserve the report, do not merge, and diagnose only from safe stage/phase/error fields before proposing another product change.

---

### Task 5.5: Carry confirmed v3 evidence into the v2 harness without rewriting history

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`
- Private only: `input\confirmed-evidence-portability.json`

**Why this is required:**

Task 5 intentionally copies the user-confirmed v3 profile and matching card byte-for-byte. Those envelopes honestly record `private-full-chain-harness.v1`, the v3 manifest hash, and the v3 evaluated commit. The v2 runner correctly rejects them as native v2 outputs. Rewriting their metadata would create false history, while rerunning unchanged profile/card generation would produce new output that requires another user confirmation.

**Interfaces:**

- An offline binding mode creates a sidecar proof and performs no model, settings, network, browser, database, or platform access.
- The original confirmed profile/card files remain byte-identical.
- The proof binds the exact source files and source v1 manifest to the target v2 manifest, plus unchanged resume/identity/model hashes and unchanged profile/card consumer-code blobs.
- `match-live` accepts v1 confirmed inputs only with a valid explicit sidecar. The existing native v2 path remains unchanged.
- Results record the portability proof hash and source harness. Baseline and candidate results must match on both fields.

- [ ] **Step 1: Write failing portability tests**

Cover:

- v1 confirmed inputs still fail without a sidecar;
- a valid sidecar permits both injected baseline and candidate match runs with the same byte-identical confirmed inputs;
- creating the proof does not change either confirmed file;
- missing/tampered proof, manifest, profile, card, draft, confirmation, resume/identity/model hash, commit binding, or consumer-code blob fails before settings resolution, provider initialization, SQLite creation, or model calls;
- unknown source harnesses fail closed;
- native v2 confirmed inputs continue to pass;
- compare rejects unequal portability proof/source-harness fields.

- [ ] **Step 2: Verify red**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: fail because no offline portability mode or proof validation exists.

- [ ] **Step 3: Implement the minimal sidecar**

The sidecar contains hashes, harness identifiers, commit identifiers, generic confirmation IDs/timestamps, and consumer blob IDs only. It must not contain profile/card/resume/JD content, model settings, endpoint, key, company/title/URL, or filesystem paths.

Require exact equality of the source and target copies for:

- confirmed profile file bytes;
- confirmed card file bytes;
- redacted resume;
- identity manifest;
- frozen jobs;
- confirmed labels.

Require source v1 envelope self-consistency and cross-link consistency. Require target v2 manifest binding. Require unchanged Git blobs for the profile/card creation and consumption boundary (`profile_onboarding.js`, `matching_card.js`, `search_plan.js`, and `llm_analyzer.js`) between the source candidate evaluated commit and the target candidate product commit.

- [ ] **Step 4: Verify green and commit**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
git diff --check
```

Commit the tracked runner, tests, and this plan update as ordinary history. Do not amend previous commits.

- [ ] **Step 5: Rebuild fresh v4-r2 harness artifacts**

Create a new single-parent baseline and a new v4-r2 package; do not overwrite the already verified v4 preflight package. Copy the same eight input/label files byte-for-byte, initialize a new v2 manifest, create the sidecar offline, verify the bundle, and leave run directories empty.

Only after all of Task 5.5 is green may Task 6 begin against v4-r2.

---

### Task 7: Repair the v4-r2 structured-output truncation

**Observed v4-r2 result:**

- Baseline: 20 rows, 1 failed, recommendation accuracy 0.70, bucket accuracy 0.75.
- Candidate: 20 rows, 14 failed, recommendation accuracy 0.20, bucket accuracy 0.20.
- Candidate safe failure metadata: 10 `MODEL_OUTPUT_TRUNCATED`, 4 `MODEL_INVALID_RESPONSE`; 11 failures at `understandJob`, 3 at `matchJob`; all failures occurred in the initial phase.
- The offline comparator correctly wrote `accepted=false`; this result is preserved and must not be merged.

**Files:**
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `tests/model_adapter_smoke.js`

- [x] **Step 1: Establish the root cause without reading private content**

The formal runtime path supplies provider, model, endpoint, and timeout but does not override the adapter's 4096-token default. Structured response failures were retried with the same prompt, input, and output budget. Successful candidate cache entries were materially larger than the baseline, while the safe provider metadata explicitly classified ten failures as truncated.

- [x] **Step 2: Write the failing adapter regression**

Use a local fake HTTP server. Return `finish_reason=length` or an invalid response envelope at 4096 tokens, then return valid JSON only when the retry budget is 8192. Also assert that an ordinary HTTP retry stays at 4096 and that existing zero-retry structured failures remain failures.

- [x] **Step 3: Implement the minimal adaptive retry**

Keep the first request and all ordinary retries unchanged. Only when an already-authorized retry follows `MODEL_OUTPUT_TRUNCATED`, `MODEL_INVALID_JSON`, or `MODEL_INVALID_RESPONSE`, double the response budget up to 8192. Do not change prompts, fields, JD coverage, concurrency, timeout, or contract validation.

- [x] **Step 4: Verify, commit, and rebuild an identity-matched package**

Run the targeted semantic and private-runner smoke tests, then the full offline suite from a clean commit. Create a fresh single-parent baseline harness and fresh package bound to the new candidate product/evaluated commits; do not overwrite v4-r2.

- [x] **Step 5: Rerun the two live sides serially and compare offline**

Use the same frozen confirmed inputs, labels, formal model identity, and existing authorizations in this continuous execution window. Preserve both results even if rejected. Do not reduce output fields or array coverage without a separate quantified product-quality decision.

The v4-r3 run was preserved and rejected: truncation fell from 10 to 0, but the candidate still had 9 `MODEL_INVALID_RESPONSE` failures and 2 contract-repair failures. The result proves that a larger budget alone is insufficient.

---

### Task 8: Recover from JSON-output empty or invalid envelopes

**Files:**
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/job_analysis.js`
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

- [x] **Step 1: Write failing fallback and safe-telemetry tests**

Cover a JSON-mode request that returns an invalid envelope at 4096, an empty/invalid JSON content response at 8192, and valid JSON only after `response_format` is removed. Require a single fallback request, preserve zero-retry behavior, and prove safe failure subtype/token-budget propagation through the semantic pipeline and private result rows.

- [x] **Step 2: Add one bounded JSON-mode recovery request**

After all configured JSON-mode attempts fail with `MODEL_INVALID_JSON` or `MODEL_INVALID_RESPONSE`, and only when retries are enabled, issue one final request without `response_format`. Keep the system instruction requiring JSON, the current 8192 cap, timeout, serial execution, and all contracts unchanged. Do not apply this fallback to truncation-only, HTTP, timeout, or transport failures.

- [x] **Step 3: Add content-free failure metadata**

Classify only `truncated_content`, `invalid_response_json`, `invalid_envelope`, `missing_content`, or `invalid_content_json`, plus the numeric requested token budget. Never persist response text, prompt text, settings, endpoint, job content, or provider error body.

- [ ] **Step 4: Verify, review, commit, and build a fresh package**

Run the targeted tests and full offline suites from clean commits. Build a new single-parent baseline harness and new private package; do not overwrite v4-r2 or v4-r3.

- [ ] **Step 5: Run the next serial comparison**

Use the same frozen inputs and labels. The candidate must have `failed=0` and must not regress recommendation/bucket accuracy or hard-placement metrics relative to its same-manifest baseline.

---

### Task 9: Add a bounded diagnostic subset before another 20-row run

The user chose a small root-cause probe before another full live comparison because each 20-row serial cycle is slow. This does not reduce the final 20-row acceptance target.

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

- [x] **Step 1: Write the failing diagnostic-subset regression**

Require an explicit list of one to five unique zero-based indices. The runner must validate the complete frozen job/label fixture and confirmed evidence chain first, then analyze only the requested rows serially.

- [x] **Step 2: Mark diagnostic output as ineligible for acceptance**

Record `diagnosticMode=true`, `acceptanceEligible=false`, the frozen total, and the selected indices. A full run records the inverse flags. The formal comparator rejects any diagnostic result.

- [ ] **Step 3: Commit and rebuild a fresh diagnostic package**

Keep the previous v4-r4 preflight package untouched. Create a new single-parent baseline with the exact shared runner blob and a new private package with byte-identical confirmed inputs and labels.

- [ ] **Step 4: Run a small candidate probe**

Select up to five rows that failed safely in the preserved v4-r3 candidate result, without exposing job IDs or content. If the bounded JSON recovery still fails, diagnose from the allowlisted stage/phase/response-kind/token fields before spending a full 20-row run.

- [ ] **Step 5: Preserve the full gate**

Only after the diagnostic probe is stable, create another fresh package and run the complete baseline and candidate sides serially. Diagnostic rows or caches must not be reused as formal acceptance evidence.
