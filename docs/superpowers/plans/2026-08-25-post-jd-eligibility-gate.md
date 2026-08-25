# Post-JD Eligibility Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent internship-only and explicit cohort-mismatch jobs from becoming recommendations or communication candidates after the complete trusted JD has been read, without reducing JD coverage or treating weak wording as a hard exclusion.

**Architecture:** Introduce one deterministic eligibility evaluator beside the existing scorer. It consumes normalized job facts plus candidate facts and returns `eligible`, `blocked`, or `review` with evidence. The scorer applies hard-block tags before model analysis; review cases remain visible but are capped to a cautious result and excluded from communication. The model may enrich the explanation, but cannot override or silently omit a locally provable eligibility boundary.

**Tech Stack:** Node.js 22 CommonJS, SQLite-backed existing stores, existing scoring/analysis pipeline, assert-based smoke tests.

## Global Constraints

- Use the trusted complete JD already obtained by the production `trusted_pane` path; do not reduce JD reads or add another BOSS acquisition path.
- Do not enable, repair, validate, or delete `search_page_api`; do not reintroduce general `standalone_detail`.
- Do not classify a role as internship merely because the JD mentions internship experience or uses daily pay.
- Hard eligibility evidence must beat any skill score or model recommendation. Ambiguous evidence must become review, not an invented mismatch.
- The interrupted communication batch remains immutable and must not be replayed. A later real test requires a newly built batch and new explicit authorization.
- After this material screening change, quality comparison must use a fresh empty operational job-history baseline while preserving profile, resume, search plan, and model settings.

---

### Task 1: Define deterministic eligibility semantics from complete job facts

**Files:**
- Create: `src/core/job_eligibility.js`
- Create: `tests/job_eligibility_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
evaluateJobEligibility(job, {
  candidateProfile,
  targetJobTypes,
}) => {
  status: "eligible" | "blocked" | "review",
  employmentType: "full_time" | "internship" | "mixed" | "unknown",
  reasonCode: string,
  qualityTags: string[],
  risks: string[],
  evidence: { job: string[], candidate: string[] },
}
```

Evidence snippets must be short, deduplicated, and derived from normalized input. The evaluator must be pure and must not call a model or browser.

- [ ] **Step 1: Write RED tests for role-type evidence**

Cover: explicit internship title, JD `实习周期4-6个月`, JD `实习时长`, explicit `实习生岗位`, `有实习经验优先`, daily salary alone, and `可接受实习生` without another hard signal.

Expected results:

- explicit role/cycle/duration -> `blocked` for a full-time target with `internship_role`;
- experience preference and daily salary alone -> not blocked;
- `可接受实习生` alone -> `mixed` or `unknown`, not a hard internship block.

- [ ] **Step 2: Write RED tests for cohort semantics**

Cover required `26/27届毕业生` against a 2024 graduation fact, one accepted year among several education facts, `2027届优先`, `可接受应届生`, explicit `仅面向在校生`, and missing candidate graduation facts.

Expected results:

- explicit required mismatch -> `blocked` with `cohort_mismatch`;
- soft preference -> not blocked;
- a potentially mandatory clause with insufficient candidate facts -> `review` with `eligibility_review`.

- [ ] **Step 3: Register and run the new test to confirm RED**

Run: `node tests/job_eligibility_smoke.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the minimum pure evaluator**

Use narrow clause classification rather than a single broad keyword regular expression. Normalize candidate graduation years from the existing profile education structure. Keep mandatory and soft modifiers explicit. Do not add an NLP dependency.

- [ ] **Step 5: Run the focused test to confirm GREEN**

Run: `node tests/job_eligibility_smoke.js`

Expected: PASS.

### Task 2: Apply the gate after complete-JD scoring

**Files:**
- Modify: `tests/screening_quality_smoke.js`
- Modify: `src/core/scoring.js`
- Modify: `src/cli.js`

**Interfaces:**
- `scoreJob(job, configs)` adds `eligibilityStatus`, `employmentType`, `eligibilityEvidence`, and eligibility tags/risks to its existing result.
- `decisionState(job)` continues to return hard-blocked for `internship_role` and gains the explicit `cohort_mismatch` hard block.
- A review item remains analyzable but carries `eligibility_review` for the later cap and communication exclusion.

- [ ] **Step 1: Write failing scoring integration tests**

Construct two high-skill jobs matching the observed failures: an ordinary title with an internship-cycle sentence, and a 26/27-only role against a 2024 candidate profile. Assert both remain hard blocked even when their skill score would otherwise be high.

- [ ] **Step 2: Write a failing weak-evidence regression test**

Assert a normal full-time JD containing only `有实习经验优先` is not tagged `internship_role` and remains eligible for normal scoring.

- [ ] **Step 3: Run scoring tests and confirm RED**

Run: `node tests/screening_quality_smoke.js`

Expected: the complete-JD internship and cohort cases incorrectly remain ready today.

- [ ] **Step 4: Integrate the evaluator into `scoreJob()`**

Pass the complete normalized job and candidate profile into the evaluator. Merge tags and risks without duplicates. Use the existing hard-penalty/decision mechanism rather than creating a second recommendation scale.

- [ ] **Step 5: Preserve the CLI's existing rule-gate order**

Ensure `analyzeScannedJob()` sees the post-JD eligibility tags before deciding whether to call the model. A hard block may receive a concise local explanation, but the model must not be able to restore it to ready.

- [ ] **Step 6: Run scoring tests and confirm GREEN**

Run: `node tests/screening_quality_smoke.js`

Expected: PASS.

### Task 3: Make model analysis respect blocked and review eligibility

**Files:**
- Modify: `tests/workflow_scan_analysis_smoke.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/model_contract.js` only if normalization currently discards the derived employment type

**Interfaces:**
- Hard-blocked results remain `not_recommended` with the local eligibility reason after `applyRuleGuard()`.
- Review results may still use the model for useful job analysis, but their final recommendation is at most `caution`, exposes a short `资格待确认` reason, and keeps `eligibility_review`.
- `realRoleType` must reflect a locally derived trustworthy value or be omitted; do not present a constant `unknown` as if the model had judged it.

- [ ] **Step 1: Write a failing model-override test**

Return an `ideal`/high-confidence fake model analysis for a job carrying `cohort_mismatch`. Assert the final recommendation is still `not_recommended` and includes the concrete mismatch reason.

- [ ] **Step 2: Write a failing review-cap test**

Return an `ideal` model result for a job carrying `eligibility_review`. Assert the final user decision is no higher than `caution`, the review tag remains, and the explanation does not claim a proven mismatch.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/workflow_scan_analysis_smoke.js`

Expected: FAIL because eligibility review has no independent cap and role type is not derived from the new result.

- [ ] **Step 4: Extend `applyRuleGuard()` minimally**

Keep hard blocks first. Add a separate review cap after the existing rule guard, without changing the four-tier matching matrix for eligible jobs. Populate only user-relevant output: result first, then one short reason and risk.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `node tests/workflow_scan_analysis_smoke.js`

Expected: PASS.

### Task 4: Exclude unresolved eligibility from communication candidates

**Files:**
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `src/storage/communication_store.js`

**Interfaces:**
- Batch preview/build must reject both hard-block tags and `eligibility_review` regardless of the visible match bucket.
- A direct request containing an ineligible job ID must return a typed validation error and create no batch item.
- Existing confirmed batches remain immutable.

- [ ] **Step 1: Write failing batch-construction tests**

Seed otherwise-high-ranking jobs with `internship_role`, `cohort_mismatch`, and `eligibility_review`. Assert none appear in selectable candidates or a created batch. Assert normal eligible jobs remain available.

- [ ] **Step 2: Write a failing direct-ID validation test**

Attempt to construct a batch by explicitly supplying a review/blocked job ID. Assert the server/store rejects it rather than relying only on UI filtering.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/dashboard_communication_batch_smoke.js`

Expected: at least the review case is currently admitted by its recommendation bucket.

- [ ] **Step 4: Add one shared eligibility predicate at the batch boundary**

Reuse existing stored tags/status; do not re-parse the JD in the Dashboard. Apply the same predicate to candidate listing and batch creation validation so UI filtering cannot be bypassed.

- [ ] **Step 5: Run focused communication tests**

Run:

```text
node tests/dashboard_communication_batch_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/communication_executor_smoke.js
```

Expected: PASS with no execution attempt.

### Task 5: Verify, establish the new evaluation boundary, and commit

**Files:**
- Modify only files required by failures found above.

- [ ] **Step 1: Run the focused quality suite**

Run:

```text
node tests/job_eligibility_smoke.js
node tests/screening_quality_smoke.js
node tests/workflow_scan_analysis_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: PASS.

- [ ] **Step 2: Run the complete offline suite**

Run: `npm test`

Expected: every offline check passes.

- [ ] **Step 3: Review false-positive boundaries**

Inspect the exact clauses for `实习经验`, soft `优先/可接受/欢迎`, daily salary, and cohort requirements. Confirm no broad `includes("实习")` or daily-pay-only rule can hard block a role.

- [ ] **Step 4: Record the manual-acceptance prerequisite**

Before measuring real recommendation quality, reset only operational job history through the project's supported baseline mechanism. Preserve candidate profile, resume, search plan, and model settings. Do not perform this reset until the later manual-acceptance phase.

- [ ] **Step 5: Review and commit**

Run `git diff --check`, inspect every changed hunk, then commit the evaluator, integration, and regressions with:

```text
fix: gate recommendations on job eligibility
```
