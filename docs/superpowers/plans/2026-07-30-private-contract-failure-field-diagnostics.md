# Private Contract-Failure Field Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe contract-failure field categories to the private benchmark runner, synchronize the reviewed runner to the baseline, and rerun only frozen index `4` in a new private diagnostic root.

**Architecture:** Reuse the existing private telemetry collector and logger events. Convert in-memory contract error messages to a closed enum, discard the messages, and let the existing row spread persist only two enum fields. Do not change product matching, prompts, validators, model configuration, or retry behavior.

**Tech Stack:** Node.js CommonJS, built-in `assert`, PowerShell, Git, existing RoleFlow offline test scripts.

## Global Constraints

- Candidate product commit remains `87cc68ede886ac0ef3b53f960c38548cce4a831a`.
- Baseline product commit remains `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Modify only acceptance tooling, tests, and documentation; do not change product matching behavior.
- Never persist or print contract error text, invalid output, repaired output, prompt, JD, resume, identity, title, company, URL, provider, model, base URL, API key, or model configuration.
- Do not expose arbitrary keys from `outputShape`.
- Preserve `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730` unchanged.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730` absent.
- The only new live diagnostic index is zero-based `4`.
- All private input and output remains under `D:\DevData\RoleFlow-private-benchmark`.
- Do not access BOSS, cookies, `D:\Guo\ZhiPing\data\jobs.sqlite`, or port 8787.
- Formal model settings may be read only by the reviewed private runner during the live step.

---

### Task 1: Add a red privacy regression

**Files:**
- Modify: `tests/private_full_chain_runner_smoke.js:2018-2235`
- Test: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Consumes: the existing fake analyzer logger and `runPrivateFullChain(..., telemetrySeam)`.
- Produces: failing expectations for `initialContractFailureCategory` and `repairContractFailureCategory`.

- [ ] **Step 1: Extend the fake telemetry events**

For the existing telemetry row at `index === 1`, emit both existing logger
events with deliberately sensitive text:

```js
const contractDiagnosticSecret = "PRIVATE_CONTRACT_DIAGNOSTIC_MUST_NOT_LEAK";

logger.warn("model_contract_repair_requested", {
  kind: "matchJob",
  errorMessage: `matchJob contract selectedTrackId invalid ${contractDiagnosticSecret}`,
  outputShape: { [contractDiagnosticSecret]: "object" }
});
logger.warn("model_contract_repair_failed", {
  kind: "matchJob",
  initialErrorMessage: `matchJob contract selectedTrackId invalid ${contractDiagnosticSecret}`,
  errorMessage: `matchJob contract roleResumeEvidence invalid ${contractDiagnosticSecret}`,
  outputShape: { [contractDiagnosticSecret]: "array" }
});
```

For the existing reset-probe row at `index === 3`, emit unknown messages:

```js
logger.warn("model_contract_repair_requested", {
  kind: "matchJob",
  errorMessage: contractDiagnosticSecret
});
logger.warn("model_contract_repair_failed", {
  kind: "matchJob",
  initialErrorMessage: contractDiagnosticSecret,
  errorMessage: contractDiagnosticSecret
});
```

- [ ] **Step 2: Add the two exact row keys**

Add these names to `telemetryFields`, so the existing exact-schema assertion
rejects either missing or extra telemetry:

```js
"initialContractFailureCategory",
"repairContractFailureCategory",
```

- [ ] **Step 3: Add category, reset, and privacy assertions**

Add:

```js
assert.deepStrictEqual(
  {
    initial: telemetryResult.rows[0].initialContractFailureCategory,
    repair: telemetryResult.rows[0].repairContractFailureCategory
  },
  { initial: "none", repair: "none" },
  "normal rows must not report contract failures"
);
assert.deepStrictEqual(
  {
    initial: telemetryResult.rows[1].initialContractFailureCategory,
    repair: telemetryResult.rows[1].repairContractFailureCategory
  },
  { initial: "selected_track", repair: "role_resume_evidence" },
  "repair telemetry must expose only fixed contract categories"
);
assert.deepStrictEqual(
  {
    initial: telemetryResult.rows[2].initialContractFailureCategory,
    repair: telemetryResult.rows[2].repairContractFailureCategory
  },
  { initial: "none", repair: "none" },
  "collector reset must prevent contract categories leaking to the next row"
);
assert.deepStrictEqual(
  {
    initial: telemetryResult.rows[3].initialContractFailureCategory,
    repair: telemetryResult.rows[3].repairContractFailureCategory
  },
  { initial: "other", repair: "other" },
  "unknown contract messages must fail closed to other"
);
assert(
  !JSON.stringify(telemetryResult).includes(contractDiagnosticSecret),
  "private output must not contain contract error text or arbitrary output-shape keys"
);
```

- [ ] **Step 4: Run the red test**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: FAIL because the two category fields are absent or `undefined`.
The sensitive marker must not be the reason for failure.

- [ ] **Step 5: Preserve red evidence**

Record the failing assertion name and exit code in the execution notes. Do not
commit the red-only state.

---

### Task 2: Implement the minimum private collector change

**Files:**
- Modify: `scripts/private-full-chain-runner.js:40-110`
- Modify: `scripts/private-full-chain-runner.js:1674-1740`
- Test: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Consumes: `model_contract_repair_requested` fields `errorMessage` and
  `model_contract_repair_failed` fields `initialErrorMessage` and
  `errorMessage`.
- Produces: the closed strings `initialContractFailureCategory` and
  `repairContractFailureCategory` in each telemetry snapshot.

- [ ] **Step 1: Add the closed category set**

Near the existing safe telemetry constants, add:

```js
const SAFE_CONTRACT_FAILURE_CATEGORIES = new Set([
  "selected_track",
  "role_alignment",
  "role_resume_evidence",
  "role_gaps",
  "requirement_matches",
  "eligibility",
  "unknown_keys",
  "result_shape",
  "other",
  "none"
]);
```

- [ ] **Step 2: Add the private classifier**

Immediately before `createPrivateTelemetryCollector`, add:

```js
function privateContractFailureCategory(value) {
  const message = String(value || "");
  if (!message) return "none";
  if (/selectedTrackId/.test(message)) return "selected_track";
  if (/roleResumeEvidence/.test(message)) return "role_resume_evidence";
  if (/roleAlignment/.test(message)) return "role_alignment";
  if (/roleGaps/.test(message)) return "role_gaps";
  if (/\beligibility\b/.test(message)) return "eligibility";
  if (/\bmatches\b|requirement|coverage/i.test(message)) return "requirement_matches";
  if (/unknown key|unknown field|unexpected key|未知字段|不允许字段/i.test(message)) return "unknown_keys";
  if (/must be (?:an? )?(?:object|array)|必须是(?:对象|数组)|result shape/i.test(message)) {
    return "result_shape";
  }
  return "other";
}
```

The function must return literals only. Do not return `message`, regex
captures, `outputShape`, or arbitrary keys.

- [ ] **Step 3: Reset the two fields**

Add to the collector's `values` object:

```js
initialContractFailureCategory: "none",
repairContractFailureCategory: "none",
```

- [ ] **Step 4: Collect requested and failed repair categories**

Replace the current repair-request branch with:

```js
if (event === "model_contract_repair_requested") {
  values.contractRepairCount = Math.min(
    MAX_SAFE_TELEMETRY_INTEGER,
    values.contractRepairCount + 1
  );
  values.initialContractFailureCategory = safeEnum(
    privateContractFailureCategory(data?.errorMessage),
    SAFE_CONTRACT_FAILURE_CATEGORIES,
    "other"
  );
  return;
}
if (event === "model_contract_repair_failed") {
  if (values.initialContractFailureCategory === "none") {
    values.initialContractFailureCategory = safeEnum(
      privateContractFailureCategory(data?.initialErrorMessage),
      SAFE_CONTRACT_FAILURE_CATEGORIES,
      "other"
    );
  }
  values.repairContractFailureCategory = safeEnum(
    privateContractFailureCategory(data?.errorMessage),
    SAFE_CONTRACT_FAILURE_CATEGORIES,
    "other"
  );
  return;
}
```

Do not add any other row fields or log files. The existing
`...telemetryValues` row spread is the only persistence path.

- [ ] **Step 5: Run the focused green test**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: PASS, including exact-schema and sensitive-marker assertions.

- [ ] **Step 6: Run candidate offline regression**

Run:

```powershell
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
```

Expected:

- 31 benchmark fixtures pass;
- all candidate offline checks pass;
- `git diff --check` exits 0.

- [ ] **Step 7: Commit the candidate evaluated checkpoint**

Run:

```powershell
git add -- scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git diff --cached --check
git commit -m "test: expose private contract failure categories"
$candidateEvaluated = git rev-parse HEAD
git merge-base --is-ancestor 87cc68ede886ac0ef3b53f960c38548cce4a831a $candidateEvaluated
if ($LASTEXITCODE -ne 0) { throw 'candidate product commit is not an ancestor' }
$evaluationBranch = 'codex/multi-track-recall-contract-diagnostic-v1'
$existing = git branch --list $evaluationBranch
if ($existing) {
  if ((git rev-parse $evaluationBranch) -ne $candidateEvaluated) {
    throw 'diagnostic evaluation branch already points to another commit'
  }
} else {
  git branch $evaluationBranch $candidateEvaluated
}
```

Expected: a clean candidate checkpoint whose product ancestor remains
`87cc68ede886ac0ef3b53f960c38548cce4a831a`.

---

### Task 3: Independently review and mirror the runner to baseline

**Files:**
- Read: `scripts/private-full-chain-runner.js`
- Read: `tests/private_full_chain_runner_smoke.js`
- Modify: `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1\scripts\private-full-chain-runner.js`

**Interfaces:**
- Consumes: the committed candidate runner from Task 2.
- Produces: a reviewed baseline evaluated commit with a byte-identical runner.

- [ ] **Step 1: Request a read-only candidate review**

Give the reviewer the design spec, this plan, the candidate commit, and these
questions:

```text
1. Can any raw error text or arbitrary output-shape key reach the row?
2. Are classifier returns restricted to the closed enum?
3. Does reset prevent cross-row leakage?
4. Are matching, prompts, validators, retries, and model calls unchanged?
5. Are there any Critical, Important, or Moderate findings?
```

Expected: `Spec PASS` and `Code quality APPROVED` before mirroring. Fix any
Important or Critical finding with a new red-green cycle and repeat review.

- [ ] **Step 2: Verify baseline state**

Run:

```powershell
$baseline = 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1'
$baselineBefore = '63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6'
if ((git -C $baseline rev-parse HEAD) -ne $baselineBefore) { throw 'baseline drifted' }
if (git -C $baseline status --porcelain) { throw 'baseline is dirty' }
```

- [ ] **Step 3: Mechanically mirror only the runner**

Run:

```powershell
$candidateRunner = 'C:\Users\Administrator\.codex\worktrees\e843\ZhiPing\scripts\private-full-chain-runner.js'
$baselineRunner = Join-Path $baseline 'scripts\private-full-chain-runner.js'
Copy-Item -LiteralPath $candidateRunner -Destination $baselineRunner
```

Do not copy the candidate smoke test. The baseline already runs its native
offline suite against the mirrored runner.

- [ ] **Step 4: Run baseline regression**

Run:

```powershell
node (Join-Path $baseline 'tests\job_match_benchmark.js')
Push-Location $baseline
try {
  npm.cmd test
  git diff --check
} finally {
  Pop-Location
}
```

Expected:

- 31 benchmark fixtures pass;
- all baseline native offline checks pass;
- diff check exits 0.

- [ ] **Step 5: Commit the baseline evaluated checkpoint**

Run:

```powershell
git -C $baseline add -- scripts/private-full-chain-runner.js
git -C $baseline diff --cached --check
git -C $baseline commit -m "test: mirror private contract failure diagnostics"
$baselineEvaluated = git -C $baseline rev-parse HEAD
git -C $baseline merge-base --is-ancestor fb0168afce265cf351f03e80f66d9e0f24015887 $baselineEvaluated
if ($LASTEXITCODE -ne 0) { throw 'baseline product commit is not an ancestor' }
```

- [ ] **Step 6: Verify all shared blobs**

Run:

```powershell
$candidateEvaluated = git rev-parse HEAD
$shared = @(
  'scripts/private-full-chain-runner.js',
  'scripts/lib/benchmark_metrics.js',
  'scripts/lib/private_resume_privacy.js'
)
foreach ($path in $shared) {
  $candidateBlob = git rev-parse "${candidateEvaluated}:$path"
  $baselineBlob = git -C $baseline rev-parse "${baselineEvaluated}:$path"
  if ($candidateBlob -ne $baselineBlob) { throw "shared blob mismatch: $path" }
}
```

Expected: all three blob IDs match.

---

### Task 4: Record the reviewed diagnostic checkpoint

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md`
- Modify: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Read: `docs/superpowers/specs/2026-07-30-private-contract-failure-field-diagnostics-design.md`

**Interfaces:**
- Consumes: candidate and baseline evaluated commit IDs from Tasks 2 and 3.
- Produces: the authoritative one-row diagnostic procedure.

- [ ] **Step 1: Record the failed three-row evidence**

Add the following facts to both plans:

```text
The fresh three-row process exited 0 and produced all three rows.
Frozen index 4 failed after matchJob contract repair with
MODEL_CONTRACT_INVALID and analysis_pending.
Indices 9 and 10 were structurally complete, but the run is not accepted.
The failed root is immutable and the 20-row run remains prohibited.
```

Do not include job IDs, titles, evidence text, model output, configuration, or
private log contents.

- [ ] **Step 2: Record evaluated commits and the new root**

Record the actual `$candidateEvaluated` and `$baselineEvaluated` values, keep
the product commits unchanged, and set the only next live root to:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730
```

The only diagnostic index is zero-based `4`.

- [ ] **Step 3: Run documentation gates**

Run:

```powershell
git diff --check
rg -n "multi-track-recall-index-4-contract-diagnostic-v1-20260730|diagnostic-indices.*4|MODEL_CONTRACT_INVALID" `
  docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md `
  docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md
```

Expected: the new root and single index are consistent in both plans; the old
failed root appears only as preserved evidence.

- [ ] **Step 4: Request independent docs review**

Require no Critical, Important, or Moderate finding and final:

```text
Spec PASS
Code quality APPROVED
```

- [ ] **Step 5: Commit and push**

Run:

```powershell
git add -- `
  docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md `
  docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md
git diff --cached --check
git commit -m "docs: record contract failure diagnostic checkpoint"
git push
```

---

### Task 5: Run only frozen index 4 in a fresh diagnostic root

**Files:**
- Private source: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- Frozen pool: `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`
- Create: `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730`
- Fixed candidate: `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`
- Baseline: `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1`

**Interfaces:**
- Consumes: reviewed candidate/baseline evaluated commits and frozen v1
  evidence.
- Produces: one private result row containing only the two safe contract
  categories needed for the next root-cause decision.

- [ ] **Step 1: Reverify immutable inputs**

Run:

```powershell
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
$jobsSha = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'input\jobs.private.json')).Hash.ToLowerInvariant()
$labelsSha = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'labels\jobs.reviewed.json')).Hash.ToLowerInvariant()
if ($jobsSha -ne '612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b') {
  throw 'frozen jobs hash mismatch'
}
if ($labelsSha -ne '97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39') {
  throw 'frozen labels hash mismatch'
}
```

- [ ] **Step 2: Create the new private bundle**

```powershell
$source = 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
$root = 'D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730'
if (Test-Path -LiteralPath $root) { throw "private root already exists: $root" }
foreach ($directory in @('input', 'labels', 'runs\candidate', 'reports')) {
  New-Item -ItemType Directory -Path (Join-Path $root $directory) | Out-Null
}
Copy-Item -LiteralPath (Join-Path $source 'input\confirmed-profile.private.json') -Destination (Join-Path $root 'input\confirmed-profile.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\confirmed-card.private.json') -Destination (Join-Path $root 'input\confirmed-card.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\identity.private.json') -Destination (Join-Path $root 'input\identity.private.json')
Copy-Item -LiteralPath (Join-Path $source 'input\resume.redacted.txt') -Destination (Join-Path $root 'input\resume.redacted.txt')
Copy-Item -LiteralPath (Join-Path $source 'input\parse-report.json') -Destination (Join-Path $root 'input\parse-report.json')
Copy-Item -LiteralPath (Join-Path $pool 'input\jobs.private.json') -Destination (Join-Path $root 'input\jobs.private.json')
Copy-Item -LiteralPath (Join-Path $pool 'labels\jobs.reviewed.json') -Destination (Join-Path $root 'labels\jobs.reviewed.json')
if ((Get-FileHash -Algorithm SHA256 (Join-Path $root 'input\jobs.private.json')).Hash.ToLowerInvariant() -ne $jobsSha) {
  throw 'copied jobs hash mismatch'
}
if ((Get-FileHash -Algorithm SHA256 (Join-Path $root 'labels\jobs.reviewed.json')).Hash.ToLowerInvariant() -ne $labelsSha) {
  throw 'copied labels hash mismatch'
}
```

- [ ] **Step 3: Stage the reviewed candidate**

Require the fixed candidate worktree to be clean at the recorded original
branch and commit:

```powershell
$candidate = 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$originalBranch = 'codex/claude-generic-evidence-matching-live-fix'
$originalCommit = '1fc49dac3670a71c720bfcaed943fa29204d93c5'
$evaluationBranch = 'codex/multi-track-recall-contract-diagnostic-v1'
if (git -C $candidate status --porcelain) { throw 'fixed candidate is dirty' }
if ((git -C $candidate branch --show-current) -ne $originalBranch) { throw 'original branch drifted' }
if ((git -C $candidate rev-parse HEAD) -ne $originalCommit) { throw 'original commit drifted' }
$candidateEvaluated = git -C $candidate rev-parse $evaluationBranch
if (-not $candidateEvaluated) { throw 'reviewed diagnostic branch is missing' }
git -C $candidate merge-base --is-ancestor 87cc68ede886ac0ef3b53f960c38548cce4a831a $candidateEvaluated
if ($LASTEXITCODE -ne 0) { throw 'candidate product is not an ancestor of evaluated commit' }
git -C $candidate switch $evaluationBranch
if ((git -C $candidate rev-parse HEAD) -ne $candidateEvaluated) { throw 'candidate switch drifted' }
```

- [ ] **Step 4: Initialize and verify the v3 private bundle**

Run:

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK = 'YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK = 'YES'
$env:ROLEFLOW_APPROVED_BASELINE_PRODUCT_COMMIT = 'fb0168afce265cf351f03e80f66d9e0f24015887'
$baseline = 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1'
$baselineProduct = 'fb0168afce265cf351f03e80f66d9e0f24015887'
$candidateProduct = '87cc68ede886ac0ef3b53f960c38548cce4a831a'
$baselineEvaluated = git -C $baseline rev-parse HEAD
$runner = Join-Path $candidate 'scripts\private-full-chain-runner.js'
$node = (Get-Command node -ErrorAction Stop).Source

& $node $runner --init-manifest `
  --private-root $root `
  --baseline-worktree $baseline `
  --candidate-worktree $candidate `
  --baseline-product-commit $baselineProduct `
  --candidate-product-commit $candidateProduct `
  --output (Join-Path $root 'run-manifest.json')
if ($LASTEXITCODE -ne 0) { throw 'init-manifest failed' }

& $node $runner --create-portability-proof `
  --source-private-root $source `
  --private-root $root `
  --proof-version confirmed-evidence-portability.v3 `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
if ($LASTEXITCODE -ne 0) { throw 'create-portability-proof failed' }

& $node $runner --verify-private-bundle `
  --private-root $root `
  --resume-text (Join-Path $root 'input\resume.redacted.txt') `
  --identity (Join-Path $root 'input\identity.private.json') `
  --parse-report (Join-Path $root 'input\parse-report.json')
if ($LASTEXITCODE -ne 0) { throw 'verify-private-bundle failed' }
```

Require every native exit code to be 0 before the model step.

- [ ] **Step 5: Run only zero-based index 4**

Run:

```powershell
$stdout = Join-Path $root 'reports\match-live.stdout.log'
$stderr = Join-Path $root 'reports\match-live.stderr.log'
$resultFile = Join-Path $root 'runs\candidate\match-result.json'
if ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr) -or (Test-Path -LiteralPath $resultFile)) {
  throw 'new diagnostic root already contains live output'
}
$arguments = @(
  $runner
  '--match-live'
  '--private-root', $root
  '--side', 'candidate'
  '--profile', (Join-Path $root 'input\confirmed-profile.private.json')
  '--matching-card', (Join-Path $root 'input\confirmed-card.private.json')
  '--jobs', (Join-Path $root 'input\jobs.private.json')
  '--labels', (Join-Path $root 'labels\jobs.reviewed.json')
  '--portability-proof', (Join-Path $root 'input\confirmed-evidence-portability.json')
  '--model-settings-root', 'D:\Guo\ZhiPing'
  '--diagnostic-indices', '4'
  '--output', (Join-Path $root 'runs\candidate')
)
$process = Start-Process `
  -FilePath $node `
  -ArgumentList $arguments `
  -Wait `
  -PassThru `
  -NoNewWindow `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr
if ($process.ExitCode -ne 0) { throw "one-row diagnostic failed with exit code $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $resultFile)) { throw 'one-row result missing' }
```

Require process exit code 0 and exactly one result row.

- [ ] **Step 6: Inspect only safe diagnostic fields**

Run:

```powershell
$env:ROLEFLOW_SAFE_RESULT = $resultFile
@'
const fs = require("fs");
const result = JSON.parse(fs.readFileSync(process.env.ROLEFLOW_SAFE_RESULT, "utf8"));
if (!Array.isArray(result.rows) || result.rows.length !== 1) {
  throw new Error("expected exactly one diagnostic row");
}
const safe = {
  total: result.total,
  failed: result.failed,
  pending: result.pending,
  partial: result.partial,
  actualBucket: result.rows[0].actualBucket,
  semanticStatus: result.rows[0].semanticStatus,
  errorCode: result.rows[0].errorCode,
  failureStage: result.rows[0].failureStage,
  failurePhase: result.rows[0].failurePhase,
  contractRepairCount: result.rows[0].contractRepairCount,
  initialContractFailureCategory: result.rows[0].initialContractFailureCategory,
  repairContractFailureCategory: result.rows[0].repairContractFailureCategory
};
console.log(JSON.stringify(safe));
'@ | node -
```

Do not print any other field.

- [ ] **Step 7: Restore the fixed candidate immediately**

Run:

```powershell
if (git -C $candidate status --porcelain) { throw 'candidate became dirty' }
git -C $candidate switch $originalBranch
if ((git -C $candidate rev-parse HEAD) -ne $originalCommit) { throw 'restore failed' }
if (git -C $candidate status --porcelain) { throw 'candidate dirty after restore' }
```

- [ ] **Step 8: Stop for the evidence-driven root-cause decision**

Preserve the one-row diagnostic root. Do not rerun index `4`, do not run the
three-row acceptance, and do not create the 20-row root until the safe category
identifies the next change and that change receives its own red-green review.
