# Salary Target and Flexible Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep BOSS acquisition on its broad `10-20K` lane while ranking jobs and preselecting communication candidates against the candidate's real `9-14K` target.

**Architecture:** Reuse the existing scoring pipeline and add three salary-fit quality tags after salary and experience parsing. Let the existing storage decision and sorting functions consume those tags, then cap the dashboard's default checked candidates with two product-policy constants. Update Search Plan #1 in the local database only after offline tests pass, and rescore its existing observations without any BOSS access.

**Tech Stack:** Node.js 22 CommonJS, built-in `assert`, SQLite through the project's existing storage layer, server-rendered HTML.

## Global Constraints

- BOSS acquisition remains `platform.salaryLanes: ["10-20K"]`, resolving to `salary=405`.
- Candidate salary target is `salary: { minK: 9, maxK: 14 }`.
- `salary_target_core`: parsed range overlaps 9-14K and lower bound is at most 14K.
- `salary_target_stretch`: lower bound is 15-16K and the job is not a 3-5 year high-salary backup.
- `salary_target_high`: lower bound is at least 17K, or 3-5 years with lower bound at least 15K.
- Stretch jobs cannot be `primary`; high-salary jobs must be `backup` but remain visible.
- Check at most 30 `primary`/`talk` jobs by default; never check `backup` by default.
- 22 checked jobs is the acceptable daily minimum. Fewer than 22 only shows one supplemental-scan recommendation and never starts browser access.
- Do not change communication pacing, BOSS access budgets, or browser behavior.
- Do not add dependencies or new framework layers.
- Do not modify `docs/data_baseline.md`, `docs/session_checkpoint.md`, or `logs/`.

---

### Task 1: Salary-Fit Classification and Decision Buckets

**Files:**
- Modify: `tests/screening_quality_smoke.js`
- Modify: `src/core/scoring.js:155-233`
- Modify: `src/core/scoring.js:359-365`
- Modify: `src/core/storage.js:2664-2700`

**Interfaces:**
- Consumes: `scoreJob(job, configs)` with `configs.scoring.salary.expected_min_k` and `expected_max_k`.
- Produces: `qualityTags` containing exactly one of `salary_target_core`, `salary_target_stretch`, or `salary_target_high` when salary is parseable and matches one class.
- Produces: `decisionState(job)` that leaves wide-mode high-salary roles ready for backup classification.
- Produces: `decisionBucket(job)` that returns `backup` for `salary_target_high` and never returns `primary` for `salary_target_stretch`.

- [ ] **Step 1: Add failing salary classification assertions**

Add a `9-14K` wide-mode fixture and these assertions to `tests/screening_quality_smoke.js`:

```js
const salaryTargetConfigs = {
  ...configs,
  scoring: {
    ...configs.scoring,
    experience: { selected: ["经验不限", "0-3年", "1-3年", "3-5年（可冲）"], allowStretch: true },
    salary: { ...configs.scoring.salary, expected_min_k: 9, expected_max_k: 14, mode: "wide" }
  }
};
const coreSalary = scoreJob(job({ experience: "1-3年", salary: "12-18K" }), salaryTargetConfigs);
assert(coreSalary.qualityTags.includes("salary_target_core"));

const stretchSalary = scoreJob(job({ experience: "1-3年", salary: "15-20K" }), salaryTargetConfigs);
assert(stretchSalary.qualityTags.includes("salary_target_stretch"));
assert.notStrictEqual(decisionBucket({ ...stretchSalary, analysis: completeApplyAnalysis() }), "primary");

const highExperienceSalary = scoreJob(job({ experience: "3-5年", salary: "15-20K" }), salaryTargetConfigs);
assert(highExperienceSalary.qualityTags.includes("salary_target_high"));
assert.strictEqual(decisionState(highExperienceSalary), "ready");
assert.strictEqual(decisionBucket({ ...highExperienceSalary, analysis: completeApplyAnalysis() }), "backup");

const highSalary = scoreJob(job({ experience: "1-3年", salary: "17-25K" }), salaryTargetConfigs);
assert(highSalary.qualityTags.includes("salary_target_high"));
assert.strictEqual(decisionBucket({ ...highSalary, analysis: completeApplyAnalysis() }), "backup");

const unknownTargetSalary = scoreJob(job({ experience: "1-3年", salary: "" }), salaryTargetConfigs);
assert(unknownTargetSalary.qualityTags.includes("salary_unverified"));
assert(!unknownTargetSalary.qualityTags.some((tag) => tag.startsWith("salary_target_")));
```

Define the test helper beside other fixture helpers:

```js
function completeApplyAnalysis() {
  return { semanticStatus: "complete", recommendation: "apply", confidence: 0.9, evidence: { jd: ["Python"], resume: ["Python"] } };
}
```

- [ ] **Step 2: Run the focused smoke test and verify RED**

Run: `node tests/screening_quality_smoke.js`

Expected: FAIL because `salary_target_core`, `salary_target_stretch`, and `salary_target_high` are absent.

- [ ] **Step 3: Add the minimal classification in the existing scoring flow**

After `stretchRequested` is known in `src/core/scoring.js`, append one target tag only when both salary bounds and a positive target maximum exist:

```js
const salaryTargetTag = salary.min === null || salary.max === null || salaryMax <= 0
  ? ""
  : (salary.min >= salaryMax + 3 || (stretchRequested && salary.min >= salaryMax + 1))
    ? "salary_target_high"
    : salary.min >= salaryMax + 1
      ? "salary_target_stretch"
      : salary.max >= salaryMin && salary.min <= salaryMax
        ? "salary_target_core"
        : "";
if (salaryTargetTag) qualityTags.push(salaryTargetTag);
if (salaryTargetTag === "salary_target_stretch") risks.push("薪资起点略高于目标，需结合职责确认");
if (salaryTargetTag === "salary_target_high") risks.push("薪资起点与经验门槛明显高于当前目标，作为备选");
```

Remove `experience_salary_above_target` from `decisionState()` hard blockers so wide-mode jobs remain visible. Keep `salary_out_of_range` as a strict-mode blocker.

In `decisionBucket()` add the salary rules before semantic recommendation handling and add stretch to `needsConversation`:

```js
if (tags.has("salary_target_high")) return "backup";
```

```js
const needsConversation = analysis.realRoleType === "implementation_presales"
  || tags.has("salary_target_stretch")
  || tags.has("experience_stretch")
  || tags.has("experience_overrange")
  || (analysis.hiddenRisks || []).some((risk) => ["medium", "high"].includes(risk?.severity));
```

Also include `salary_target_stretch` in the fallback `requiresConversation` expression.

- [ ] **Step 4: Run the focused smoke test and verify GREEN**

Run: `node tests/screening_quality_smoke.js`

Expected: PASS and print the existing screening-quality success message.

- [ ] **Step 5: Commit the classification change**

```bash
git add tests/screening_quality_smoke.js src/core/scoring.js src/core/storage.js
git commit -m "feat: classify jobs by candidate salary target"
```

---

### Task 2: Salary-Aware Ordering Inside Decision Buckets

**Files:**
- Modify: `tests/screening_quality_smoke.js`
- Modify: `src/core/storage.js:2765-2815`

**Interfaces:**
- Consumes: salary target tags produced by Task 1.
- Produces: `salaryPreferenceRank(job): number`, used only by `compareReportJobs()`.
- Ordering: core `0`, stretch `1`, unverified/unclassified `2`, high `3`.

- [ ] **Step 1: Add a failing integrated ordering assertion**

Seed four otherwise-equivalent report jobs in the existing smoke database with decision bucket `talk` inputs and quality tags for high, unclassified, stretch, and core. Read them through `listDecisionPool(db, { planId })` and assert:

```js
assert.deepStrictEqual(
  salaryOrderedJobs.map((item) => item.qualityTags.find((tag) => tag.startsWith("salary_target_")) || "unclassified"),
  ["salary_target_core", "salary_target_stretch", "unclassified", "salary_target_high"]
);
```

Use equal model confidence, work schedule, risks, and activity so only salary preference distinguishes them.

- [ ] **Step 2: Run the focused smoke test and verify RED**

Run: `node tests/screening_quality_smoke.js`

Expected: FAIL because current sorting uses model confidence before any salary preference.

- [ ] **Step 3: Add one local rank helper and use it in the comparator**

In `src/core/storage.js` insert salary ranking immediately after decision-bucket ranking:

```js
function compareReportJobs(a, b) {
  return statusRank(a) - statusRank(b)
    || decisionBucketRank(a.decisionBucket) - decisionBucketRank(b.decisionBucket)
    || salaryPreferenceRank(a) - salaryPreferenceRank(b)
    || modelConfidenceRank(a) - modelConfidenceRank(b)
    || workScheduleRank(a) - workScheduleRank(b)
    || (a.feedbackRank || 0) - (b.feedbackRank || 0)
    || qualityRank(a) - qualityRank(b)
    || (a.risks || []).length - (b.risks || []).length
    || activeRank(a.effectiveBossActiveDays ?? a.bossActiveDays) - activeRank(b.effectiveBossActiveDays ?? b.bossActiveDays)
    || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
}

function salaryPreferenceRank(job) {
  const tags = new Set(job.qualityTags || []);
  if (tags.has("salary_target_core")) return 0;
  if (tags.has("salary_target_stretch")) return 1;
  if (tags.has("salary_target_high")) return 3;
  return 2;
}
```

- [ ] **Step 4: Run the focused smoke test and verify GREEN**

Run: `node tests/screening_quality_smoke.js`

Expected: PASS.

- [ ] **Step 5: Commit the ordering change**

```bash
git add tests/screening_quality_smoke.js src/core/storage.js
git commit -m "feat: rank jobs by salary fit"
```

---

### Task 3: Flexible Communication Batch Defaults

**Files:**
- Modify: `tests/dashboard_communication_batch_smoke.js`
- Modify: `src/core/product_policy.js:1-106`
- Modify: `src/dashboard/server.js:1713-1726`

**Interfaces:**
- Consumes: `PRODUCT_POLICY.operations.bossCommunication.selection.targetCount` and `.acceptableMin`.
- Produces: at most 30 checked `primary`/`talk` checkboxes.
- Produces: Chinese status copy that recommends no scan for 22-30 checked jobs and one user-triggered supplemental scan below 22.

- [ ] **Step 1: Add failing builder fixtures and assertions**

Extend `seed()` to create at least 32 eligible `primary`/`talk` jobs plus one backup. Assert the first 30 eligible IDs are checked, the 31st and 32nd are present but unchecked, and backup remains unchecked:

```js
assert.strictEqual((builder.body.match(/name="jobIds"[^>]*checked/g) || []).length, 30);
assert.match(builder.body, /已达到日常沟通区间，无需为凑满 30 个补扫/);
```

Create a second plan with 21 eligible `primary`/`talk` jobs and request its builder page:

```js
assert.match(smallBuilder.body, /当前可沟通候选不足 22 个，可在风险额度允许时补扫一轮/);
assert.doesNotMatch(smallBuilder.body, /自动补扫|开始补扫/);
```

- [ ] **Step 2: Run the dashboard smoke test and verify RED**

Run: `node tests/dashboard_communication_batch_smoke.js`

Expected: FAIL because every current primary/talk job is checked and no flexible-target status is rendered.

- [ ] **Step 3: Add product policy constants and cap default checks**

Increment `PRODUCT_POLICY_VERSION` to `2026-07-20.3` and add this frozen block inside `bossCommunication`:

```js
selection: Object.freeze({ targetCount: 30, acceptableMin: 22 }),
```

In `renderCommunicationBuilderPage()` derive default IDs from the already sorted eligible pool:

```js
const selection = PRODUCT_POLICY.operations.bossCommunication.selection;
const defaultIds = new Set(eligible
  .filter((job) => ["primary", "talk"].includes(job.decisionBucket))
  .slice(0, selection.targetCount)
  .map((job) => job.id));
const defaultCount = defaultIds.size;
const targetNotice = defaultCount >= selection.acceptableMin
  ? `已达到日常沟通区间，无需为凑满 ${selection.targetCount} 个补扫。`
  : `当前可沟通候选不足 ${selection.acceptableMin} 个，可在风险额度允许时补扫一轮。`;
```

Set `checked` only when `defaultIds.has(job.id)`, and render `targetNotice` above the form. Do not add any scan button or route.

- [ ] **Step 4: Run the dashboard smoke test and verify GREEN**

Run: `node tests/dashboard_communication_batch_smoke.js`

Expected: PASS.

- [ ] **Step 5: Commit the builder change**

```bash
git add tests/dashboard_communication_batch_smoke.js src/core/product_policy.js src/dashboard/server.js
git commit -m "feat: use flexible communication batch targets"
```

---

### Task 4: Keep Salary Changes in the Local Ranking Layer

**Files:**
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/core/analysis_revision.js`
- Modify: `src/core/job_analysis.js`

**Interfaces:**
- Consumes: candidate profile plus the model-relevant search-plan fields `cities`, `experience`, `jobTypes`, and `directions`.
- Produces: `runtimeAnalysisContext()` whose `searchPlanVersion` is unchanged by salary/platform/scan changes but changes when a model-relevant field changes.
- Produces: `searchPreferences` without salary; deterministic salary rules remain authoritative.

- [ ] **Step 1: Change the semantic pipeline test to the desired boundary**

Assert that `matchJob` input has no `searchPreferences.salary`. Change the existing stale-analysis fixture so changing only salary keeps `semanticStatus: "complete"` and keeps both analysis contexts equal. Add a direction-change assertion:

```js
assert.strictEqual(Object.hasOwn(input.searchPreferences, "salary"), false);
assert.deepStrictEqual(
  runtimeAnalysisContext(candidate, initialPlan),
  runtimeAnalysisContext(candidate, { ...initialPlan, salary: { minK: 15, maxK: 25 } })
);
assert.notDeepStrictEqual(
  runtimeAnalysisContext(candidate, initialPlan),
  runtimeAnalysisContext(candidate, { ...initialPlan, directions: ["AI解决方案"] })
);
```

- [ ] **Step 2: Run the semantic smoke test and verify RED**

Run: `node tests/semantic_pipeline_smoke.js`

Expected: FAIL because salary is currently sent to the model and hashes the entire Search Plan.

- [ ] **Step 3: Hash and send only model-relevant plan fields**

In `src/core/analysis_revision.js`, add a private normalized context and use it in both revision paths:

```js
function modelSearchPlanContext(searchPlan = {}) {
  return {
    cities: searchPlan.cities || [],
    experience: searchPlan.experience || [],
    jobTypes: searchPlan.jobTypes || [],
    directions: searchPlan.directions || []
  };
}
```

Remove `salary` from `searchPreferences()` in `src/core/job_analysis.js`. Do not change prompt text, model adapters, or deterministic scoring.

- [ ] **Step 4: Run the semantic smoke test and verify GREEN**

Run: `node tests/semantic_pipeline_smoke.js`

Expected: PASS.

- [ ] **Step 5: Commit the semantic-boundary fix**

```bash
git add tests/semantic_pipeline_smoke.js src/core/analysis_revision.js src/core/job_analysis.js
git commit -m "fix: keep salary changes out of semantic revisions"
```

---

### Task 5: Preserve the BOSS Acquisition Lane and Migrate Plan #1

**Files:**
- Modify: `tests/profile_quality_smoke.js`
- Data update only after tests pass: `data/jobs.sqlite`

**Interfaces:**
- Consumes: `resolveNativeFilterSnapshot({ site: "boss", catalog, plan })` and the saved `platform.salaryLanes`.
- Produces: Plan #1 with local `salary: { minK: 9, maxK: 14 }` and unchanged `platform.salaryLanes: ["10-20K"]`.
- Produces: rescored existing observations through `node src/cli.js rescore-plan --plan 1`.

- [ ] **Step 1: Add a regression assertion for platform/native salary separation**

In `tests/profile_quality_smoke.js`, build a plan with the local target and explicit BOSS lane, then resolve the stored catalog:

```js
const targetSalaryPlan = normalizeSearchPlan({
  ...modePlan,
  salaryMinK: 9,
  salaryMaxK: 14,
  platform: { site: "boss", salaryLanes: ["10-20K"] }
}, profile);
const targetSalaryFilter = resolveNativeFilterSnapshot({ site: "boss", catalog: bossCatalog, plan: targetSalaryPlan });
assert.deepStrictEqual(targetSalaryPlan.salary, { minK: 9, maxK: 14 });
assert.deepStrictEqual(targetSalaryFilter.params.salary, ["405"]);
```

Import `resolveNativeFilterSnapshot` and reuse the test's existing catalog fixture rather than creating a new mock layer.

- [ ] **Step 2: Run the profile smoke test and verify its protection**

Run: `node tests/profile_quality_smoke.js`

Expected before final assertion wiring: FAIL if the test accidentally allows local target inference to replace the explicit BOSS lane. After using the existing explicit-lane path: PASS with `salary=405`.

- [ ] **Step 3: Run the complete offline suite before touching local data**

Run: `npm.cmd test`

Expected: all offline checks pass.

- [ ] **Step 4: Back up and update only Search Plan #1**

First copy `data/jobs.sqlite` to a timestamped project-local backup under `data/backups/`. Then run a one-off Node command using `openDb`, `getSearchPlan`, and `saveSearchPlan` to preserve the complete plan object while changing only:

```js
plan.salary = { minK: 9, maxK: 14 };
plan.platform = { ...plan.platform, salaryLanes: ["10-20K"] };
```

Persist with:

```js
saveSearchPlan(db, { id: record.id, profileId: record.profileId, profileVersionId: record.profileVersionId, plan });
```

Print the saved local salary and BOSS lanes, then close the database. This command must not import or call any browser adapter.

- [ ] **Step 5: Rescore existing observations without accessing BOSS**

Run: `node src/cli.js rescore-plan --plan 1`

Expected: `Search Plan #1 已按最新规则重算 N 条岗位。` with `N` greater than zero.

- [ ] **Step 6: Verify saved plan and builder behavior locally**

Use a read-only Node command to assert:

```js
assert.deepStrictEqual(record.plan.salary, { minK: 9, maxK: 14 });
assert.deepStrictEqual(record.plan.platform.salaryLanes, ["10-20K"]);
```

Start or restart the dashboard, open `/communication/new?planId=1`, and verify its checked count is at most 30. Do not start a scan or communication batch.

- [ ] **Step 7: Run final verification**

Run:

```bash
npm.cmd test
git diff --check
git status --short
```

Expected: all offline checks pass; no whitespace errors; only intended tracked files plus the known user-owned untracked files appear.

- [ ] **Step 8: Commit and push**

```bash
git add tests/profile_quality_smoke.js
git commit -m "test: preserve broad BOSS salary acquisition"
git push origin main
```

Confirm the design commit, implementation commits, and this plan are all present on `origin/main`.

## Self-Review

- Spec coverage: classification, wide-mode visibility, decision buckets, salary ordering, 30/22 builder policy, explicit BOSS lane preservation, Plan #1 migration, and offline rescoring are each mapped to a task.
- Placeholder scan: no deferred implementation or unspecified error handling remains.
- Type consistency: all new tags are strings in `qualityTags`; selection settings are numbers at `PRODUCT_POLICY.operations.bossCommunication.selection`; existing `saveSearchPlan` and `rescore-plan` interfaces are used unchanged.
- Safety: no step performs live BOSS access, automatic supplemental scanning, or automatic communication.
