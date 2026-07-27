# Recall-first Screening Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned recall-first private acceptance policy that preserves opportunities unless a frozen label identifies an explicit exclusion, while keeping every v1 comparison and product evidence guard unchanged.

**Architecture:** Keep the existing generic benchmark comparator exact. Extend only the private full-chain fixture/result layer with optional v2 `expectedDisposition` data and locally derived recall metrics. Private v2 comparison will reuse the existing structural and identity checks, then replace only the acceptance decision with recall-first failures; v1 continues to return the existing exact acceptance decision.

**Tech Stack:** Node.js CommonJS, built-in `node:fs`, `node:crypto`, `node:sqlite`, assertion-based smoke tests, Git worktree.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix` on `codex/claude-generic-evidence-matching-live-fix`.
- Do not modify or merge into `D:\Guo\ZhiPing`.
- Do not access a real recruitment platform, browser session, `D:\Guo\ZhiPing\data\jobs.sqlite`, or port 8787.
- Private inputs and results stay under `D:\DevData\RoleFlow-private-benchmark` and are never committed.
- `private-real-jd-labels.v1` remains byte-for-byte unchanged and retains exact acceptance behavior.
- v2 requires `labelsVersion: "private-real-jd-labels.v2"` and `evaluationPolicy: "recall-first.v1"`.
- `expectedDisposition` accepts only `keep` or `exclude`.
- v2 exact recommendation/bucket metrics remain diagnostic and must not decide acceptance.
- v2 acceptance requires zero false hard exclusions, zero missed obvious exclusions, zero unresolved dispositions, zero failed/stale/pending rows, zero primary without evidence, and no partial-to-primary row.
- No new dependency, database migration, occupational taxonomy, or automatic prompt mutation.
- All behavior changes use red-green TDD.
- Real model calls, if reached, are serial and use new private output paths.

---

### Task 1: Parse v2 private labels without changing v1

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Consumes: frozen jobs plus either a v1 or v2 private label envelope.
- Produces: `privateJobsAndLabels(jobsValue, labelsValue)` with `labelsVersion`, `evaluationPolicy`, `labelsSha256`, and a `labelById` whose v2 rows contain `expectedDisposition`.

- [x] **Step 1: Write failing v2 fixture tests**

Add a helper beside the existing fixture helpers:

```js
function asRecallFirstLabels(labels) {
  return {
    ...structuredClone(labels),
    labelsVersion: "private-real-jd-labels.v2",
    evaluationPolicy: "recall-first.v1",
    rows: labels.rows.map((row) => ({
      ...row,
      expectedDisposition: row.expectedBucket === "not_recommended" ? "exclude" : "keep"
    }))
  };
}
```

Add tests proving:

```js
const v2Probe = createMatchProbeBundle("labels-v2-valid");
const v2Labels = asRecallFirstLabels(JSON.parse(fs.readFileSync(v2Probe.labels, "utf8")));
fs.writeFileSync(v2Probe.labels, JSON.stringify(v2Labels), "utf8");
await assert.doesNotReject(() => runner.runPrivateFullChain(/* existing injected match options */));
```

Also assert safe rejection for:

- v2 without `evaluationPolicy`;
- v2 with a different policy value;
- v2 row without `expectedDisposition`;
- v2 row with `expectedDisposition: "maybe"`;
- v1 with an added v2-only field;
- v2 with any unrecognized extra envelope or row field.

- [x] **Step 2: Run the private runner smoke and verify red**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: fail because `private-real-jd-labels.v2` is rejected by the current fixture validator.

- [x] **Step 3: Implement version-specific schemas**

In `scripts/private-full-chain-runner.js`, replace the single label schema with:

```js
const PRIVATE_LABEL_V1_KEYS = ["id", "expectedRecommendation", "expectedBucket", "rationale"];
const PRIVATE_LABEL_V2_KEYS = [...PRIVATE_LABEL_V1_KEYS, "expectedDisposition"];
const PRIVATE_DISPOSITIONS = new Set(["keep", "exclude"]);
const RECALL_FIRST_POLICY = "recall-first.v1";
```

In `privateJobsAndLabels`:

```js
const isV1 = labelsValue?.labelsVersion === "private-real-jd-labels.v1";
const isV2 = labelsValue?.labelsVersion === "private-real-jd-labels.v2";
const labelEnvelopeKeys = isV2
  ? ["labelsVersion", "evaluationPolicy", "userConfirmed", "confirmedAt", "jobsSha256", "rows"]
  : ["labelsVersion", "userConfirmed", "confirmedAt", "jobsSha256", "rows"];
```

Require `evaluationPolicy === RECALL_FIRST_POLICY` only for v2. Validate v1 rows against `PRIVATE_LABEL_V1_KEYS`; validate v2 rows against `PRIVATE_LABEL_V2_KEYS` and `PRIVATE_DISPOSITIONS`.

Also require v2 label consistency:

```js
const dispositionPairValid = label.expectedDisposition === "exclude"
  ? label.expectedRecommendation === "skip" && label.expectedBucket === "not_recommended"
  : label.expectedBucket !== "not_recommended";
```

This makes the existing exact `falseHardExclusion` equal to the recall-first false exclusion, while recommendation/bucket accuracy can remain diagnostic.

Return:

```js
{
  jobs,
  labels,
  labelsVersion: labelsValue.labelsVersion,
  evaluationPolicy: isV2 ? RECALL_FIRST_POLICY : "exact.v1",
  jobsSha256,
  labelsSha256: valueSha256(labelsValue),
  labelById: new Map(labels.map((label) => [String(label.id), label]))
}
```

- [x] **Step 4: Run v1 and v2 fixture tests**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: `private_full_chain_runner_smoke offline gates ok`.

- [x] **Step 5: Commit**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: accept recall-first private labels"
```

---

### Task 2: Derive recall metrics from rows

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Produces: `deriveRecallFirstMetrics(rows)` returning `{ ok, metrics }`.
- `metrics` includes `expectedKeep`, `retainedOpportunity`, `falseHardExclusion`, `expectedExclude`, `obviousMismatchExcluded`, `missedObviousExclusion`, `unresolvedDisposition`, `opportunityRetentionRate`, `obviousExclusionRate`, and the corresponding sorted ID arrays.

- [x] **Step 1: Write failing pure metric tests**

Export and test a wished-for function:

```js
const recallRows = [
  { id: "keep-talk", expectedDisposition: "keep", actualBucket: "talk" },
  { id: "keep-primary", expectedDisposition: "keep", actualBucket: "primary" },
  { id: "exclude", expectedDisposition: "exclude", actualBucket: "not_recommended" }
];
assert.deepStrictEqual(runner.deriveRecallFirstMetrics(recallRows).metrics, {
  expectedKeep: 2,
  retainedOpportunity: 2,
  falseHardExclusion: 0,
  falseHardExclusionIds: [],
  expectedExclude: 1,
  obviousMismatchExcluded: 1,
  missedObviousExclusion: 0,
  missedObviousExclusionIds: [],
  unresolvedDisposition: 0,
  unresolvedDispositionIds: [],
  opportunityRetentionRate: 1,
  obviousExclusionRate: 1
});
```

Add one row for each failure:

- `keep -> not_recommended`;
- `exclude -> talk`;
- any row -> `analysis_pending`;
- any row -> `refresh`;
- duplicate/empty ID;
- illegal expected disposition;
- illegal actual bucket.

- [x] **Step 2: Run and verify red**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: fail with `runner.deriveRecallFirstMetrics is not a function`.

- [x] **Step 3: Implement the pure derivation**

Add:

```js
function deriveRecallFirstMetrics(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return fail("BENCHMARK_COMPARE_METRICS", "Recall-first results require non-empty rows.");
  }
  const ids = new Set();
  const allowedBuckets = new Set(["primary", "talk", "backup", "analysis_pending", "refresh", "not_recommended"]);
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id || ids.has(id) || !PRIVATE_DISPOSITIONS.has(row.expectedDisposition)
      || !allowedBuckets.has(row.actualBucket)) {
      return fail("BENCHMARK_COMPARE_METRICS", "Recall-first row structure is invalid.");
    }
    ids.add(id);
  }
  // Derive every count and ID array from rows; never trust stored summaries.
}
```

Use zero-safe rates: when a class has no expected rows, its rate is `1`.

- [x] **Step 4: Attach metrics to v2 match results**

When building result rows, include:

```js
expectedDisposition: label.expectedDisposition || null
```

After exact `deriveBenchmarkMetrics(rows)`, run `deriveRecallFirstMetrics(rows)` only when the fixture policy is recall-first. Add:

```js
labelsVersion: fixture.labelsVersion,
evaluationPolicy: fixture.evaluationPolicy,
...(recallDerived ? recallDerived.metrics : {})
```

For v1, do not add v2 row fields or recall summaries.

- [x] **Step 5: Run targeted tests**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/job_match_benchmark.js
node tests/generic_evidence_matching_smoke.js
```

Expected: all pass; generic exact metrics remain unchanged.

- [x] **Step 6: Commit**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: derive recall-first private metrics"
```

---

### Task 3: Apply the v2 acceptance gate

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Produces: v2 private comparison report with `evaluationPolicy`, `recall`, `accepted`, and `failureReasons`.
- Preserves: v1 report and exact acceptance behavior.

- [x] **Step 1: Write failing v2 comparison tests**

Create structurally valid baseline/candidate result pairs with identical v2 identity and recomputed exact plus recall summaries.

Assert:

```js
// Exact recommendation changed but the opportunity stayed retained.
assert.strictEqual(compare(keepTalkBaseline, keepPrimaryCandidate).report.accepted, true);

// Recall failures are absolute, not merely relative to baseline.
assert.strictEqual(compare(keepTalkBaseline, keepExcludedCandidate).report.accepted, false);
assert.match(compare(...).report.failureReasons.join("\n"), /错误硬排除/);
assert.strictEqual(compare(excludedBaseline, excludedAsTalkCandidate).report.accepted, false);
assert.match(compare(...).report.failureReasons.join("\n"), /明确排除漏拦/);
```

Also assert:

- unresolved disposition fails;
- `primaryWithoutEvidence` fails;
- `partial -> primary` fails;
- candidate changing `expectedDisposition` fails structurally;
- forged recall summary fails with `BENCHMARK_COMPARE_METRICS`;
- v1 exact accuracy regression still fails exactly as before.

- [x] **Step 2: Run and verify red**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: v2 pair is still rejected by the shared exact accuracy gate or lacks recall report fields.

- [x] **Step 3: Verify recall identity and summaries**

Before the shared comparator result is accepted:

```js
const recallMode = baseline.evaluationPolicy === RECALL_FIRST_POLICY
  && candidate.evaluationPolicy === RECALL_FIRST_POLICY;
```

Require both sides to have the same `labelsVersion` and `evaluationPolicy`. For v2:

- compare each row's `expectedDisposition`;
- recompute recall summaries with `deriveRecallFirstMetrics`;
- strictly compare every stored recall field and ID array with recomputed values.

- [x] **Step 4: Replace only v2 acceptance**

Keep the shared comparator for all structural, Git, model, profile/card, fixture, label and exact-summary checks. For v2, derive failures:

```js
function recallFirstAcceptanceFailures(candidate) {
  const failures = [];
  for (const field of ["failed", "stale", "pending", "primaryWithoutEvidence", "unresolvedDisposition"]) {
    if (candidate[field] !== 0) failures.push(`候选 ${field}=${candidate[field]}，召回优先验收要求为 0`);
  }
  if (candidate.falseHardExclusion !== 0) failures.push("存在错误硬排除");
  if (candidate.missedObviousExclusion !== 0) failures.push("存在明确排除漏拦");
  if (candidate.rows.some((row) => row.semanticStatus === "partial" && row.actualBucket === "primary")) {
    failures.push("存在 partial -> primary");
  }
  return failures;
}
```

Set v2 report acceptance from those failures. Do not copy shared exact-accuracy failures into v2 `failureReasons`; preserve exact metrics under `baseline`, `candidate`, `deltas`, `regressions`, and `improvements`.

- [x] **Step 5: Extend the private Markdown report**

Add only aggregate fields:

```md
- Evaluation policy: recall-first.v1
- Opportunities retained: N/N
- False hard exclusions: N
- Obvious mismatches excluded: N/N
- Missed obvious exclusions: N
```

Do not write job IDs, titles, companies, rationale, resume text, endpoint, or key to Markdown.

- [x] **Step 6: Run targeted tests**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected: all pass.

- [x] **Step 7: Commit**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: gate private comparison on opportunity recall"
```

---

### Task 4: Create and confirm the private v2 label draft

**Files:**
- Private create: `D:\DevData\RoleFlow-private-benchmark\full-chain-v6-recall-v2-20260726\labels\jobs.reviewed.json`
- Private create: copied inputs and a new `run-manifest.json`
- No Git-tracked private file

**Interfaces:**
- Consumes: confirmed v1 bundle `D:\DevData\RoleFlow-private-benchmark\full-chain-v3-20260726`.
- Produces: a distinct v2 bundle with the same jobs, profile, card, resume and identity hashes.

- [x] **Step 1: Create a new bundle without overwriting any prior package**

Verify the target does not exist. Copy the seven confirmed input/label source files exactly, then transform only the copied label file.

- [x] **Step 2: Produce an unconfirmed v2 draft**

Use Node `fs.readFileSync(path, "utf8")` and `JSON.parse`. Preserve all IDs and rationales privately.

Set:

```js
labelsVersion = "private-real-jd-labels.v2";
evaluationPolicy = "recall-first.v1";
userConfirmed = false;
confirmedAt = "";
```

Classify:

- the two rows whose existing private rationale contains an explicit eligibility conflict as `exclude`, retaining `skip/not_recommended`;
- the other eighteen rows as `keep`;
- the eleven former role/evidence-only skips use diagnostic `review/talk`;
- the seven already non-skip rows retain their diagnostic exact labels.

Write no raw row content to terminal output. Print only total, keep count, exclude count, changed row count, source hash, and draft hash.

- [x] **Step 3: Run offline fixture validation**

Use a temporary copy with `userConfirmed:true` and a valid confirmation timestamp only for offline schema validation with an injected fake adapter. Do not run a real model.

Expected: v2 accepted; removing or changing any disposition fails before provider or SQLite initialization.

- [x] **Step 4: One concentrated user confirmation**

Present only:

- total 20;
- keep 18;
- exclude 2;
- 11 former strict skips changed to keep/review-talk;
- no profile, card, JD or rationale changes.

After explicit confirmation, set `userConfirmed:true`, set a new timestamp, freeze the v2 labels hash, and never edit that file in place again.

Implementation checkpoint (2026-07-26):

- Task 1 commit: `b06b7ad` (`feat: accept recall-first private labels`).
- Task 2 commit: `7ccac32` (`feat: derive recall-first private metrics`).
- Task 3 commit: `8efc01d` (`feat: gate private comparison on opportunity recall`).
- The separate private v2 bundle contains 20 frozen rows: 18 `keep`, 2 `exclude`; 11 former strict skips are diagnostic `review/talk`.
- The confirmed v2 label file, profile, card, resume, identity and JD inputs remain outside Git.
- Offline fixture validation accepted all 20 v2 rows and rejected missing or invalid dispositions before provider or SQLite initialization.
- `node tests/run_all.js`: all 47 offline checks passed.
- Independent read-only review of `d9b497e..8efc01d` found no Critical, Important or Minor issues and assessed the implementation as ready for the bounded diagnostic.
- The first v6 manifest preflight stopped before any live call because the baseline did not yet share the v2 runner blobs. After rebuilding a single-parent baseline, the existing portability v1 proof correctly rejected the intentionally changed labels.
- Commit `373ada1` adds `confirmed-evidence-portability.v2`: profile, card, resume, identity and jobs must remain byte-identical; only a confirmed `private-real-jd-labels.v1` to confirmed recall-first v2 transition may change label bytes, and both label hashes and versions are bound into the proof. Portability v1 remains unchanged.
- Independent review found no portability-proof issues. Commit `96e7382` additionally locks out changed-label v1→v1, v2→v1, v2→v2 and invalid-policy transitions.
- Because the v6 manifest is immutable, the bounded diagnostic uses a fresh v7 private bundle rather than overwriting the stopped preflight package.

---

### Task 5: Run a three-row real diagnostic

**Files:**
- Private create: fresh v2 diagnostic result/log/cache paths
- Modify after results: `docs/superpowers/plans/2026-07-26-recall-first-screening-acceptance.md`

**Interfaces:**
- Consumes: confirmed v2 bundle and current read-only model settings.
- Produces: one diagnostic containing the retained borderline cases actually present in the frozen sample. Do not invent an `exclude` label merely to balance the fixture.

- [x] **Step 1: Create an evaluated docs checkpoint**

The latest product commit must be a strict ancestor of a docs-only evaluated commit. Initialize the private manifest with those exact commits and the approved baseline product commit.

- [x] **Step 2: Verify bundle and portability**

Run the existing `--create-portability-proof` and `--verify-private-bundle` modes. Verify exact copied hashes without printing private contents.

- [x] **Step 3: Select three indices safely**

Private local inspection found that the two remaining `exclude` labels contradicted the confirmed recall-first policy: one JD used inclusive fresh-graduate wording rather than an exclusive cohort restriction, and the other was only an experience-years gap. The user confirmed both as `keep`, producing a 20-keep / 0-exclude v2 fixture. Select three keep rows covering:

- the previously observed former strict-skip row;
- the inclusive cohort-language correction;
- the experience-years soft-signal correction.

Print only the numeric indices.

- [x] **Step 4: Run candidate match serially**

Use:

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
node scripts/private-full-chain-runner.js --match-live `
  --side candidate `
  --private-root '<fresh confirmed recall-first bundle>' `
  --profile '<private confirmed profile>' `
  --matching-card '<private confirmed card>' `
  --jobs '<private frozen jobs>' `
  --labels '<private confirmed v2 labels>' `
  --portability-proof '<private portability proof>' `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --diagnostic-indices '<three numeric indices>' `
  --output '<new private diagnostic directory>'
```

Redirect stdout/stderr to private logs. Poll every 30 seconds. Do not print model responses.

- [ ] **Step 5: Evaluate safe aggregates**

Require:

- total 3;
- failed/stale/pending/partial/unresolved all zero;
- false hard exclusion zero;
- missed obvious exclusion zero;
- primary without evidence zero;
- matching card consumed;
- diagnostic mode true and acceptance eligible false.

If any row fails, diagnose only the failed response shape before expanding. Do not run 20 rows automatically.

**Observed bounded diagnostics**

- The first v7 three-row run retained the known positive row and did not hard-exclude the inclusive cohort row, but one row ended in `MODEL_INVALID_RESPONSE`. A fresh one-row retry completed as `review/talk` with evidence, proving that the product rule itself retained the opportunity.
- Evidence inspection then corrected the two false `exclude` labels. The user explicitly confirmed both changes; the v8 fixture is 20 `keep`, 0 `exclude`. Offline synthetic fixtures continue to cover true eligibility, indispensable-core and safety exclusions.
- Commit `d150210` makes the inclusive wording explicit in the prompt and advances the job-understanding pipeline to v7 so old cache entries cannot mask the change. Commit `4c8b254` locks the zero-explicit-exclusion metric behavior.
- The fresh v8 three-row run retained the experience-years row as evidence-complete `review/talk` with no hard blocker. The other two rows ended at `understandJob` after exhausting the existing three-step response recovery: HTTP 200, 8192 response tokens, final request without JSON mode, `invalid_response_json`. No row was falsely hard-excluded and the run was not expanded.
- Commit `0b135a6` adds content-free response-envelope diagnostics (content-type class, envelope class, parse-failure class, length and BOM flag). It never persists the response body. The next fresh diagnostic must use the same three indices only long enough to classify the upstream envelope failure before deciding whether parsing or provider behavior needs a fix.
- A fresh two-row envelope diagnostic parsed both responses, confirming that the earlier JSON-envelope failures are intermittent rather than a deterministic parser defect. It also exposed one genuine false hard exclusion: inclusive eligibility language and resume-absence wording were being accepted as hard-conflict evidence. Commit `de5374b` fixes both shared contract boundaries, advances the affected pipeline versions, and passes all 47 offline checks. The next fresh diagnostic remains limited to the same three confirmed `keep` rows.

---

### Task 6: Full verification, review, documentation, and push

**Files:**
- Modify: `docs/superpowers/plans/2026-07-26-recall-first-screening-acceptance.md`
- Create if the diagnostic succeeds: `docs/superpowers/reports/2026-07-26-recall-first-screening-acceptance-summary.md`

**Interfaces:**
- Produces: a non-sensitive final report and a pushed isolated branch.

- [ ] **Step 1: Run the complete offline suite**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/run_all.js
git diff --check
git status --short
```

Expected: all registered offline checks pass; diff check has no output.

- [ ] **Step 2: Independent read-only review**

Review:

- v1 compatibility;
- v2 label strictness;
- row-derived summary anti-forgery;
- absolute zero false-exclusion gate;
- privacy of reports;
- no accidental runtime prompt or decision loosening beyond existing product policy.

- [ ] **Step 3: Write the non-sensitive summary**

Record only commits, harness/policy versions, total/keep/exclude counts, safe aggregate metrics, test results, and safety boundaries. Do not include private IDs, titles, companies, JD text, rationale, resume facts, URL, endpoint or key.

- [ ] **Step 4: Commit and push**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js `
  docs/superpowers/plans/2026-07-26-recall-first-screening-acceptance.md `
  docs/superpowers/reports/2026-07-26-recall-first-screening-acceptance-summary.md
git commit -m "docs: record recall-first screening acceptance"
git push origin codex/claude-generic-evidence-matching-live-fix
```

- [ ] **Step 5: Do not merge automatically**

Report the branch and commits. Leave `D:\Guo\ZhiPing`, its database, browser and 8787 untouched. Use the branch-finishing workflow only after the goal's tests, v2 confirmation and small live diagnostic are all proven.
