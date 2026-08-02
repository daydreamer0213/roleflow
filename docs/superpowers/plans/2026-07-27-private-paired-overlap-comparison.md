# Private Paired-Overlap Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare a fresh 20-row baseline and candidate on their shared usable rows while keeping incomplete coverage formally unaccepted and preserving every original live result.

**Architecture:** Keep the current full-result identity and integrity gates. After validating both complete 20-row artifacts, classify only strict initial HTTP-200 empty JSON envelopes, remove their union from both in-memory comparison projections, recompute all projected metrics with existing helpers, and report paired quality separately from full coverage. No source live result is modified.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing private full-chain runner, existing benchmark metric helpers, Git worktrees, PowerShell orchestration.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`.
- Candidate branch remains `codex/claude-generic-evidence-matching-live-fix`.
- Approved baseline product commit is `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Candidate product commit remains `ec781ee360aa473b6d77526298b0dd275d13feec`; comparator/tooling commits must be strict descendants.
- Use no new dependency and no standalone result-preprocessing tool.
- Never modify a source live result or copy a historical SQLite model cache.
- Only an initial `MODEL_INVALID_RESPONSE` with HTTP 200, JSON content type, zero content length, empty envelope and `invalid_response_json` is skippable.
- Contract repair, contract failure, pending, stale, partial, transport failure and ordinary product decisions are never skippable.
- Incomplete coverage may set `pairedAccepted=true`; it must keep `accepted=false` and make the CLI exit non-zero after writing the report.
- Private profile, resume, card, job, rationale, model body, endpoint and key content stay under `D:\DevData\RoleFlow-private-benchmark` and never enter Git or console output.
- Do not access a real recruitment platform, the main operational database or the 8787 workbench.
- Run tests with `NODE_OPTIONS=--max-old-space-size=32`.
- Live baseline and candidate runs are serial and require the already granted `ALLOW_PRIVATE_RESUME_BENCHMARK=YES` and `ALLOW_LIVE_MODEL_BENCHMARK=YES`.

---

### Task 1: Project strict empty responses into a paired comparison

**Files:**
- Modify: `scripts/private-full-chain-runner.js:1825-2002`
- Modify: `tests/private_full_chain_runner_smoke.js:1821-1957`

**Interfaces:**
- Consumes: `deriveBenchmarkMetrics(rows)`, `deriveRecallFirstMetrics(rows)`, `compareBenchmarkResults(baseline, candidate)`.
- Produces: `isSkippableEmptyResponse(row) -> boolean`.
- Produces: `pairedProjection(baseline, candidate, recallMode) -> { ok, baseline, candidate, coverage, pairedRecall } | fail(...)`.
- `coverage` has `frozenTotal`, `comparableTotal`, `excludedEmptyTotal`, `baselineEmptyTotal`, `candidateEmptyTotal`, `bothEmptyTotal`, and `fullCoverageComplete`.

- [ ] **Step 1: Add test helpers and the baseline-only/candidate-only red tests**

Add beside `asRecallFirstResult`:

```js
function asEmptyEnvelopeFailure(result, rowIndex = 0) {
  const changed = structuredClone(result);
  changed.rows[rowIndex] = {
    ...changed.rows[rowIndex],
    actualRecommendation: "review",
    actualBucket: "analysis_pending",
    semanticStatus: "failed",
    evidenceComplete: false,
    hardBlocked: false,
    decisionState: "ready",
    errorCode: "MODEL_INVALID_RESPONSE",
    failureStage: "understandJob",
    failurePhase: "initial",
    responseFailureKind: "invalid_response_json",
    requestedMaxTokens: 8192,
    responseHttpStatus: 200,
    responseJsonModeApplied: false,
    responseContentLength: 0,
    responseContentTypeKind: "json",
    responseEnvelopeKind: "empty",
    responseParseFailureKind: "other",
    responseHadUtf8Bom: false,
    pass: false
  };
  return asRecallFirstResult(changed);
}
```

Add after the existing accepted recall-first comparison:

```js
const baselineEmpty = asEmptyEnvelopeFailure(recallBaseline, 0);
const baselineEmptyCompared = runner.comparePrivateFullChainResults(baselineEmpty, recallCandidate);
assert.strictEqual(baselineEmptyCompared.ok, true);
assert.deepStrictEqual(baselineEmptyCompared.report.coverage, {
  frozenTotal: recallBaseline.rows.length,
  comparableTotal: recallBaseline.rows.length - 1,
  excludedEmptyTotal: 1,
  baselineEmptyTotal: 1,
  candidateEmptyTotal: 0,
  bothEmptyTotal: 0,
  fullCoverageComplete: false
});
assert.strictEqual(baselineEmptyCompared.report.pairedAccepted, true);
assert.strictEqual(baselineEmptyCompared.report.accepted, false);
assert.strictEqual(baselineEmptyCompared.report.status, "paired_pass_full_incomplete");

const candidateEmpty = asEmptyEnvelopeFailure(recallCandidate, 1);
const candidateEmptyCompared = runner.comparePrivateFullChainResults(recallBaseline, candidateEmpty);
assert.strictEqual(candidateEmptyCompared.report.coverage.candidateEmptyTotal, 1);
assert.strictEqual(candidateEmptyCompared.report.coverage.comparableTotal, recallBaseline.rows.length - 1);
assert.strictEqual(candidateEmptyCompared.report.pairedAccepted, true);
assert.strictEqual(candidateEmptyCompared.report.accepted, false);
```

- [ ] **Step 2: Run the test and verify the red failure**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
```

Expected: FAIL because `report.coverage`, `pairedAccepted` and the incomplete status do not exist.

- [ ] **Step 3: Add the strict classifier and projection helpers**

Add before `comparePrivateFullChainResults`:

```js
function isSkippableEmptyResponse(row) {
  return row?.semanticStatus === "failed"
    && row?.errorCode === "MODEL_INVALID_RESPONSE"
    && row?.failurePhase === "initial"
    && ["understandJob", "matchJob"].includes(row?.failureStage)
    && row?.responseFailureKind === "invalid_response_json"
    && row?.responseHttpStatus === 200
    && row?.responseContentLength === 0
    && row?.responseContentTypeKind === "json"
    && row?.responseEnvelopeKind === "empty";
}

function projectPrivateResult(value, excludedIds, recallMode) {
  const rows = value.rows.filter((row) => !excludedIds.has(String(row.id)));
  if (!rows.length) return fail("BENCHMARK_COMPARE_METRICS", "Paired overlap requires at least one comparable row.");
  const benchmark = deriveBenchmarkMetrics(rows);
  if (!benchmark.ok) return benchmark;
  const result = { ...value, rows, ...benchmark.metrics };
  if (!recallMode) return { ok: true, result, recall: null };
  const recall = deriveRecallFirstMetrics(rows);
  if (!recall.ok) return recall;
  return { ok: true, result: { ...result, ...recall.metrics }, recall: recall.metrics };
}

function pairedProjection(baseline, candidate, recallMode) {
  const baselineEmptyIds = new Set(baseline.rows.filter(isSkippableEmptyResponse).map((row) => String(row.id)));
  const candidateEmptyIds = new Set(candidate.rows.filter(isSkippableEmptyResponse).map((row) => String(row.id)));
  const excludedIds = new Set([...baselineEmptyIds, ...candidateEmptyIds]);
  const baselineProjected = projectPrivateResult(baseline, excludedIds, recallMode);
  if (!baselineProjected.ok) return baselineProjected;
  const candidateProjected = projectPrivateResult(candidate, excludedIds, recallMode);
  if (!candidateProjected.ok) return candidateProjected;
  return {
    ok: true,
    baseline: baselineProjected.result,
    candidate: candidateProjected.result,
    pairedRecall: recallMode ? {
      baseline: baselineProjected.recall,
      candidate: candidateProjected.recall
    } : null,
    coverage: {
      frozenTotal: baseline.frozenFixtureTotal,
      comparableTotal: baselineProjected.result.rows.length,
      excludedEmptyTotal: excludedIds.size,
      baselineEmptyTotal: baselineEmptyIds.size,
      candidateEmptyTotal: candidateEmptyIds.size,
      bothEmptyTotal: [...baselineEmptyIds].filter((id) => candidateEmptyIds.has(id)).length,
      fullCoverageComplete: excludedIds.size === 0
    }
  };
}

function pairedInputFailures(value, sideLabel) {
  return ["failed", "stale", "pending"]
    .filter((field) => value[field] !== 0)
    .map((field) => `${sideLabel} ${field}=${value[field]}，不是可忽略的空响应`);
}
```

- [ ] **Step 4: Integrate projection only after full identity and metric validation**

Keep the current full call:

```js
const fullCompared = compareBenchmarkResults(
  { ...baseline, evaluatedCommit: baseline.productCommit },
  candidate
);
if (!fullCompared.ok) return fullCompared;
```

Keep full recall summary validation and expected-disposition freezing before projection. After the existing full-row-length check, add:

```js
const projected = pairedProjection(baseline, candidate, recallMode);
if (!projected.ok) return projected;
const pairedCompared = projected.coverage.fullCoverageComplete
  ? fullCompared
  : compareBenchmarkResults(
      { ...projected.baseline, evaluatedCommit: projected.baseline.productCommit },
      projected.candidate
    );
if (!pairedCompared.ok) return pairedCompared;
```

Compute recall-first acceptance from `projected.candidate`, not the unfiltered candidate:

```js
const pairedFailureReasons = [...new Set([
  ...pairedInputFailures(projected.baseline, "基线"),
  ...pairedInputFailures(projected.candidate, "候选"),
  ...(recallMode
    ? recallFirstAcceptanceFailures(projected.candidate)
    : pairedCompared.report.failureReasons)
])];
const pairedAccepted = pairedFailureReasons.length === 0;
const accepted = pairedAccepted && projected.coverage.fullCoverageComplete;
const status = accepted
  ? "full_pass"
  : pairedAccepted
    ? "paired_pass_full_incomplete"
    : "paired_fail";
const failureReasons = projected.coverage.fullCoverageComplete
  ? pairedFailureReasons
  : [
      ...pairedFailureReasons,
      `有效配对 ${projected.coverage.comparableTotal}/${projected.coverage.frozenTotal}，全量覆盖未完成`
    ];
```

Build change lists from projected rows:

```js
const before = new Map(projected.baseline.rows.map((row) => [row.id, row]));
const changed = (predicate) => projected.candidate.rows
  .filter((row) => predicate(before.get(row.id), row))
  .map((row) => row.id)
  .sort();
```

Extend the report without changing the original live inputs:

```js
report: {
  ...pairedCompared.report,
  runMode: "offline-private-compare",
  coverage: projected.coverage,
  pairedAccepted,
  accepted,
  status,
  failureReasons,
  ...(recallMode ? {
    evaluationPolicy: RECALL_FIRST_POLICY,
    recall: recallMetrics,
    pairedRecall: projected.pairedRecall
  } : {}),
  fullSummary: {
    baseline: {
      total: baseline.total,
      failed: baseline.failed,
      stale: baseline.stale,
      pending: baseline.pending,
      partial: baseline.partial,
      primaryWithoutEvidence: baseline.primaryWithoutEvidence,
      hardFalsePlacement: baseline.hardFalsePlacement
    },
    candidate: {
      total: candidate.total,
      failed: candidate.failed,
      stale: candidate.stale,
      pending: candidate.pending,
      partial: candidate.partial,
      primaryWithoutEvidence: candidate.primaryWithoutEvidence,
      hardFalsePlacement: candidate.hardFalsePlacement
    }
  },
  // existing profile, card, portability, commits and change lists follow
}
```

- [ ] **Step 5: Run the targeted test and verify green**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
```

Expected: `private_full_chain_runner_smoke offline gates ok`.

- [ ] **Step 6: Add the remaining structural red/green cases**

Add assertions for:

```js
const bothSameEmpty = runner.comparePrivateFullChainResults(
  asEmptyEnvelopeFailure(recallBaseline, 0),
  asEmptyEnvelopeFailure(recallCandidate, 0)
);
assert.strictEqual(bothSameEmpty.report.coverage.excludedEmptyTotal, 1);
assert.strictEqual(bothSameEmpty.report.coverage.bothEmptyTotal, 1);

const differentEmpty = runner.comparePrivateFullChainResults(
  asEmptyEnvelopeFailure(recallBaseline, 0),
  asEmptyEnvelopeFailure(recallCandidate, 1)
);
assert.strictEqual(differentEmpty.report.coverage.excludedEmptyTotal, 2);
assert.strictEqual(differentEmpty.report.coverage.comparableTotal, recallBaseline.rows.length - 2);

const contractFailure = asEmptyEnvelopeFailure(recallCandidate, 0);
contractFailure.rows[0].errorCode = "MODEL_CONTRACT_INVALID";
Object.assign(contractFailure, deriveBenchmarkMetrics(contractFailure.rows).metrics);
Object.assign(contractFailure, runner.deriveRecallFirstMetrics(contractFailure.rows).metrics);
const contractCompared = runner.comparePrivateFullChainResults(recallBaseline, contractFailure);
assert.strictEqual(contractCompared.report.coverage.excludedEmptyTotal, 0);
assert.strictEqual(contractCompared.report.pairedAccepted, false);

const baselineContractFailure = asEmptyEnvelopeFailure(recallBaseline, 0);
baselineContractFailure.rows[0].errorCode = "MODEL_CONTRACT_INVALID";
Object.assign(baselineContractFailure, deriveBenchmarkMetrics(baselineContractFailure.rows).metrics);
Object.assign(baselineContractFailure, runner.deriveRecallFirstMetrics(baselineContractFailure.rows).metrics);
const baselineContractCompared = runner.comparePrivateFullChainResults(baselineContractFailure, recallCandidate);
assert.strictEqual(baselineContractCompared.report.coverage.excludedEmptyTotal, 0);
assert.strictEqual(baselineContractCompared.report.pairedAccepted, false);

const contractRepairEmpty = asEmptyEnvelopeFailure(recallCandidate, 0);
contractRepairEmpty.rows[0].failurePhase = "contract_repair";
Object.assign(contractRepairEmpty, deriveBenchmarkMetrics(contractRepairEmpty.rows).metrics);
Object.assign(contractRepairEmpty, runner.deriveRecallFirstMetrics(contractRepairEmpty.rows).metrics);
assert.strictEqual(
  runner.comparePrivateFullChainResults(recallBaseline, contractRepairEmpty).report.coverage.excludedEmptyTotal,
  0
);

const allEmptyBaseline = recallBaseline.rows.reduce(
  (value, _row, index) => asEmptyEnvelopeFailure(value, index),
  recallBaseline
);
const allEmptyCandidate = recallCandidate.rows.reduce(
  (value, _row, index) => asEmptyEnvelopeFailure(value, index),
  recallCandidate
);
assert.strictEqual(
  runner.comparePrivateFullChainResults(allEmptyBaseline, allEmptyCandidate).code,
  "BENCHMARK_COMPARE_METRICS"
);
```

Retain the existing forged-summary test and add an empty-row variant:

```js
const forgedBeforeProjection = {
  ...asEmptyEnvelopeFailure(recallCandidate, 0),
  failed: 0
};
assert.strictEqual(
  runner.comparePrivateFullChainResults(recallBaseline, forgedBeforeProjection).code,
  "BENCHMARK_COMPARE_METRICS"
);
```

- [ ] **Step 7: Run targeted tests**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected: all three exit 0.

- [ ] **Step 8: Commit Task 1**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: compare private benchmark overlap safely"
```

---

### Task 2: Render incomplete coverage without leaking IDs

**Files:**
- Modify: `scripts/private-full-chain-runner.js:2004-2027`
- Modify: `tests/private_full_chain_runner_smoke.js:1937-1957`

**Interfaces:**
- Consumes: Task 1 report fields `coverage`, `pairedAccepted`, `accepted`, `status`, `pairedRecall`.
- Produces: count-only Markdown coverage summary.
- Preserves: CLI writes JSON and Markdown for structurally valid comparisons and exits non-zero whenever `accepted === false`.

- [ ] **Step 1: Add a failing CLI/Markdown test**

Create an incomplete-overlap bundle with `recallBaseline` and `asEmptyEnvelopeFailure(recallCandidate, 0)`, then assert:

```js
const overlapBundle = privatePath("cli-recall-incomplete-overlap");
const overlapBaseline = path.join(overlapBundle, "runs", "baseline", "match-result.json");
const overlapCandidate = path.join(overlapBundle, "runs", "candidate", "match-result.json");
const overlapReport = path.join(overlapBundle, "reports", "full-chain-compare.json");
fs.mkdirSync(path.dirname(overlapBaseline), { recursive: true });
fs.mkdirSync(path.dirname(overlapCandidate), { recursive: true });
fs.writeFileSync(overlapBaseline, JSON.stringify(recallBaseline), "utf8");
fs.writeFileSync(overlapCandidate, JSON.stringify(asEmptyEnvelopeFailure(recallCandidate, 0)), "utf8");
const overlapCli = spawnSync(process.execPath, [
  path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
  "--compare", "--baseline", overlapBaseline, "--candidate", overlapCandidate, "--report", overlapReport
], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, ALLOW_LIVE_MODEL_BENCHMARK: "" } });
assert.notStrictEqual(overlapCli.status, 0);
const overlapJson = JSON.parse(fs.readFileSync(overlapReport, "utf8"));
assert.strictEqual(overlapJson.pairedAccepted, true);
assert.strictEqual(overlapJson.accepted, false);
assert.strictEqual(overlapJson.status, "paired_pass_full_incomplete");
const overlapMarkdown = fs.readFileSync(overlapReport.replace(/\.json$/i, ".md"), "utf8");
assert.match(overlapMarkdown, /Comparable rows:/);
assert.match(overlapMarkdown, /Full coverage complete: false/);
assert.match(overlapMarkdown, /Paired accepted: true/);
for (const row of recallBaseline.rows) {
  assert(!overlapMarkdown.includes(row.id));
}
```

- [ ] **Step 2: Run the test and verify the red failure**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
```

Expected: FAIL because the Markdown lacks paired coverage fields.

- [ ] **Step 3: Add count-only Markdown fields**

Extend `renderPrivateCompareMarkdown`:

```js
`- Status: ${report.status || (report.accepted ? "full_pass" : "paired_fail")}`,
`- Paired accepted: ${report.pairedAccepted ?? report.accepted}`,
`- Comparable rows: ${report.coverage?.comparableTotal ?? report.total}/${report.coverage?.frozenTotal ?? report.total}`,
`- Empty-response rows excluded: ${report.coverage?.excludedEmptyTotal ?? 0}`,
`- Full coverage complete: ${report.coverage?.fullCoverageComplete ?? true}`,
```

For recall-first metrics, render paired metrics when present:

```js
const recall = report.pairedRecall?.candidate || report.recall.candidate;
```

Do not add any row ID, title, company or reason to Markdown.

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected: all exit 0.

- [ ] **Step 5: Commit Task 2**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "test: report incomplete private comparison coverage"
```

---

### Task 3: Verify candidate tooling and create an identical fresh baseline harness

**Files:**
- Verify: `scripts/private-full-chain-runner.js`
- Verify: `scripts/lib/benchmark_metrics.js`
- Verify: `scripts/lib/private_resume_privacy.js`
- Create outside Git project: `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-paired-overlap`

**Interfaces:**
- Candidate evaluated commit: current clean `HEAD`.
- Candidate product commit: `ec781ee360aa473b6d77526298b0dd275d13feec`.
- Baseline product parent: `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Baseline evaluated commit: new single-parent commit containing the exact three shared candidate harness blobs.

- [ ] **Step 1: Run candidate targeted and full offline verification**

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/run_all.js
git diff --check
git status --short
```

Expected: targeted tests pass, `All 47 offline checks passed`, diff-check has no output, worktree is clean.

- [ ] **Step 2: Create the baseline worktree from the approved product commit**

First require the target to be absent:

```powershell
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-paired-overlap'
if(Test-Path -LiteralPath $baselineWorktree){ throw 'Baseline worktree target already exists.' }
git worktree add -b codex/generic-evidence-matching-private-paired-overlap-baseline `
  $baselineWorktree `
  fb0168afce265cf351f03e80f66d9e0f24015887
```

- [ ] **Step 3: Copy only the three shared harness files and commit**

```powershell
$candidate='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baseline='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-paired-overlap'
Copy-Item -LiteralPath (Join-Path $candidate 'scripts\private-full-chain-runner.js') -Destination (Join-Path $baseline 'scripts\private-full-chain-runner.js')
Copy-Item -LiteralPath (Join-Path $candidate 'scripts\lib\benchmark_metrics.js') -Destination (Join-Path $baseline 'scripts\lib\benchmark_metrics.js')
Copy-Item -LiteralPath (Join-Path $candidate 'scripts\lib\private_resume_privacy.js') -Destination (Join-Path $baseline 'scripts\lib\private_resume_privacy.js')
git -C $baseline add -- scripts/private-full-chain-runner.js scripts/lib/benchmark_metrics.js scripts/lib/private_resume_privacy.js
git -C $baseline commit -m "test: align paired overlap private harness"
```

- [ ] **Step 4: Verify single-parent topology and exact shared blobs**

```powershell
$baselineHead=git -C $baseline rev-parse HEAD
$parents=(git -C $baseline rev-list --parents -n 1 HEAD).Split(' ')
if($parents.Count -ne 2 -or $parents[1] -ne 'fb0168afce265cf351f03e80f66d9e0f24015887'){ throw 'Baseline topology mismatch.' }
foreach($file in @(
  'scripts/private-full-chain-runner.js',
  'scripts/lib/benchmark_metrics.js',
  'scripts/lib/private_resume_privacy.js'
)){
  $left=git -C $candidate rev-parse "HEAD:$file"
  $right=git -C $baseline rev-parse "HEAD:$file"
  if($left -ne $right){ throw "Shared blob mismatch: $file" }
}
```

- [ ] **Step 5: Run baseline offline verification**

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node (Join-Path $baseline 'tests\job_match_benchmark.js')
npm.cmd --prefix $baseline test
git -C $baseline diff --check
git -C $baseline status --short
```

Expected: fixture benchmark passes, baseline's registered offline suite passes, both Git checks are clean.

---

### Task 4: Run the fresh 20-row baseline and candidate serially

**Files:**
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v19-paired-overlap-20260727`
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v17-final-three-20260727\labels\jobs.reviewed.json`
- Read only: `D:\Guo\ZhiPing` model settings through the existing live gate

**Interfaces:**
- Fresh manifest binds the new baseline evaluated commit and candidate `HEAD`.
- Source confirmed evidence comes byte-for-byte from the approved v1 private source bundle.
- Current v2 labels come byte-for-byte from the user-confirmed v17 label file.
- Live outputs are `runs\baseline\match-result.json` and `runs\candidate\match-result.json`.

- [ ] **Step 1: Create the fresh private root without overwriting anything**

```powershell
$runRoot='D:\DevData\RoleFlow-private-benchmark\full-chain-v19-paired-overlap-20260727'
$sourceRoot='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$labelSource='D:\DevData\RoleFlow-private-benchmark\full-chain-v17-final-three-20260727\labels\jobs.reviewed.json'
if(Test-Path -LiteralPath $runRoot){ throw 'Fresh v19 private root already exists.' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'input') -Destination (Join-Path $runRoot 'input') -Recurse
New-Item -ItemType Directory -Path (Join-Path $runRoot 'labels') | Out-Null
Copy-Item -LiteralPath $labelSource -Destination (Join-Path $runRoot 'labels\jobs.reviewed.json')
New-Item -ItemType Directory -Path (Join-Path $runRoot 'runs') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runRoot 'reports') | Out-Null
```

- [ ] **Step 2: Initialize and verify the immutable manifest**

```powershell
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-paired-overlap'
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root $runRoot `
  --baseline-worktree $baselineWorktree `
  --candidate-worktree $candidateWorktree `
  --baseline-product-commit fb0168afce265cf351f03e80f66d9e0f24015887 `
  --candidate-product-commit ec781ee360aa473b6d77526298b0dd275d13feec `
  --output (Join-Path $runRoot 'run-manifest.json')

node scripts/private-full-chain-runner.js --verify-private-bundle `
  --private-root $runRoot `
  --identity (Join-Path $runRoot 'input\identity.private.json') `
  --resume-text (Join-Path $runRoot 'input\resume.redacted.txt') `
  --parse-report (Join-Path $runRoot 'input\parse-report.json')
```

Expected: both commands exit 0 without printing private contents.

- [ ] **Step 3: Create and verify the current portability proof**

```powershell
node scripts/private-full-chain-runner.js --create-portability-proof `
  --source-private-root $sourceRoot `
  --private-root $runRoot `
  --output (Join-Path $runRoot 'input\confirmed-evidence-portability.json')
```

Expected: exit 0; do not print the proof body.

- [ ] **Step 4: Run the baseline 20 rows**

Set:

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
$env:NODE_OPTIONS='--max-old-space-size=32'
```

Run `scripts/private-full-chain-runner.js --match-live` from the baseline worktree with:

```powershell
--side baseline
--private-root $runRoot
--profile (Join-Path $runRoot 'input\confirmed-profile.private.json')
--matching-card (Join-Path $runRoot 'input\confirmed-card.private.json')
--jobs (Join-Path $runRoot 'input\jobs.private.json')
--labels (Join-Path $runRoot 'labels\jobs.reviewed.json')
--portability-proof (Join-Path $runRoot 'input\confirmed-evidence-portability.json')
--model-settings-root 'D:\Guo\ZhiPing'
--output (Join-Path $runRoot 'runs\baseline')
```

Redirect stdout and stderr to new files under `$runRoot`, start the process with `-WindowStyle Hidden`, and poll process/result existence every 30 seconds. Never read model response bodies.

- [ ] **Step 5: Inspect baseline safe aggregates only**

Read only:

- commit and harness identity;
- total, complete, failed, stale, pending, partial;
- recommendation/bucket counts;
- evidence-complete and hard-blocked counts;
- content-free failure diagnostics by fixed safe fields.

Do not print fixture IDs or private text.

- [ ] **Step 6: Run the candidate 20 rows**

Use the same arguments from the candidate worktree, changing only:

```powershell
--side candidate
--output (Join-Path $runRoot 'runs\candidate')
```

Keep execution serial. Poll every 30 seconds and do not inspect model bodies.

- [ ] **Step 7: Inspect candidate safe aggregates only**

Use the same safe aggregate projection as Step 5. Confirm both source files still contain all 20 rows even when an empty-response row exists.

---

### Task 5: Compare, document, verify and push

**Files:**
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v19-paired-overlap-20260727\reports\full-chain-compare.json`
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v19-paired-overlap-20260727\reports\full-chain-compare.md`
- Modify: `docs/superpowers/reports/2026-07-26-recall-first-screening-acceptance-summary.md`
- Modify: `docs/superpowers/plans/2026-07-27-private-paired-overlap-comparison.md`

**Interfaces:**
- Consumes: fresh full baseline and candidate result files.
- Produces: strict full-coverage status plus paired-overlap status and safe counts.

- [ ] **Step 1: Run the offline comparison**

```powershell
node scripts/private-full-chain-runner.js --compare `
  --baseline (Join-Path $runRoot 'runs\baseline\match-result.json') `
  --candidate (Join-Path $runRoot 'runs\candidate\match-result.json') `
  --report (Join-Path $runRoot 'reports\full-chain-compare.json')
```

Expected:

- exit 0 only for a complete accepted 20/20 comparison;
- exit non-zero with both reports present for `paired_pass_full_incomplete` or `paired_fail`;
- no report for structural identity/integrity failure.

- [ ] **Step 2: Extract and review safe report fields**

Print only:

```js
{
  status,
  pairedAccepted,
  accepted,
  coverage,
  failureReasonCount,
  fullSummary,
  pairedRecommendationCounts,
  pairedBucketCounts,
  falseHardExclusion,
  missedObviousExclusion,
  primaryWithoutEvidence
}
```

Do not print IDs, job text, resume text or model output.

- [ ] **Step 3: Update the non-sensitive project report**

Record:

- candidate and baseline product/evaluated commits;
- harness, label and policy versions;
- total and comparable counts;
- empty-response counts per side;
- paired and formal acceptance states;
- recall-first aggregate results;
- offline test results and safety boundaries.

Do not include private identifiers or contents.

- [ ] **Step 4: Run final verification**

```powershell
$env:NODE_OPTIONS='--max-old-space-size=32'
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
node tests/run_all.js
git diff --check
git status --short
```

Expected: targeted tests pass, all registered offline checks pass, diff-check is clean, and only the intended documentation files remain before the final commit.

- [ ] **Step 5: Commit documentation**

```powershell
git add docs/superpowers/reports/2026-07-26-recall-first-screening-acceptance-summary.md `
  docs/superpowers/plans/2026-07-27-private-paired-overlap-comparison.md
git commit -m "docs: record paired overlap benchmark comparison"
```

- [ ] **Step 6: Push the isolated branch**

```powershell
git push origin codex/claude-generic-evidence-matching-live-fix
git status -sb
```

Expected: local `HEAD` equals the upstream branch; do not merge into the active main project.
