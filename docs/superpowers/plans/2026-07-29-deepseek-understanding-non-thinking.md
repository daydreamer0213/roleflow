# DeepSeek Non-Thinking Job Understanding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Disable DeepSeek thinking only for official DeepSeek V4 `understandJob`
requests, while preserving every other model stage, timeout, retry, token and
matching-quality rule.

**Architecture:** Keep the behavior internal to the OpenAI-compatible adapter.
Derive the request-body extension from the existing stage, model and endpoint;
do not add a persisted model setting because that would change confirmed
matching-card model fingerprints. Prove the exact outgoing JSON body offline,
then run one fresh saved-JD candidate flow through both semantic stages.

**Tech Stack:** Node.js, built-in `fetch`, `assert`, existing smoke-test runner,
existing private full-chain benchmark harness.

---

## Fixed Scope and Safety Boundary

- Candidate worktree:
  `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`
- Candidate branch: `codex/claude-generic-evidence-matching-live-fix`
- Approved product baseline:
  `fb0168afce265cf351f03e80f66d9e0f24015887`
- Harness-only baseline worktree:
  `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-empty-response-v1`
- Harness-only baseline commit:
  `86679ca8cddfb312e4025a8c330319fb41b3d385`
- Frozen private input source:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728`
- Confirmed-evidence source:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`
- New private diagnostic root:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v31-deepseek-nonthinking-single-20260729`

Do not access BOSS or any browser. Do not read or write
`D:\Guo\ZhiPing\data\jobs.sqlite`, start port 8787, copy model settings or
secrets, print prompts/JDs/resume text/model response bodies, or run more than
saved job index 0. Formal model settings may be read only through the existing
authorized `--model-settings-root D:\Guo\ZhiPing` gate.

### Task 1: Add the stage-specific DeepSeek request body

**Files:**

- Modify: `tests/model_adapter_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`

**Behavioral contract:**

- Add `thinking: { type: "disabled" }` only when all of these are true:
  - stage is exactly `understandJob`;
  - endpoint hostname is exactly `api.deepseek.com`;
  - model is exactly `deepseek-v4-pro` or `deepseek-v4-flash`,
    case-insensitively.
- Official DeepSeek V4 `matchJob` receives no `thinking` field.
- Other models on the official endpoint receive no `thinking` field.
- DeepSeek-named models on custom endpoints receive no `thinking` field.
- Do not change the provider config schema, settings UI, model identity,
  timeout, retry count, token limit, JSON-mode fallback, contract repair or
  telemetry schema.

- [ ] **Step 1: Read the test-double safety rules before adding a fetch seam**

Read the complete `testing-anti-patterns.md` file referenced by the
test-driven-development skill. Use the fetch replacement only to observe the
real adapter request body; do not test a newly exported helper or duplicate
production logic in the test.

- [ ] **Step 2: Write the four failing request-body assertions**

In `tests/model_adapter_smoke.js`, temporarily replace `global.fetch` inside a
small `try/finally` block. Capture parsed request bodies and return a minimal
valid JSON response. Exercise:

```js
[
  ["https://api.deepseek.com", "deepseek-v4-pro", "understandJob", true],
  ["https://api.deepseek.com", "deepseek-v4-pro", "matchJob", false],
  ["https://api.deepseek.com", "other-model", "understandJob", false],
  ["https://example.invalid", "deepseek-v4-pro", "understandJob", false]
]
```

Also cover `deepseek-v4-flash` without creating a second test harness. Restore
the original fetch in `finally`, even when an assertion fails.

- [ ] **Step 3: Run the red test**

```powershell
node tests/model_adapter_smoke.js
```

Expected: fail only because the official DeepSeek V4 `understandJob` request
does not yet contain `thinking: {type: "disabled"}`. No network request occurs.

- [ ] **Step 4: Implement the smallest adapter-only condition**

In `src/adapters/models/openai_compatible.js`:

1. add a private set containing the two allowed DeepSeek V4 model names;
2. add a private predicate that safely parses `this.baseUrl`, compares the
   normalized hostname/model and checks `kind === "understandJob"`;
3. pass `kind` from `chatJson()` into `requestJson()`;
4. after constructing the request body, add the `thinking` object only when the
   predicate returns true.

Do not export the predicate and do not add a dependency or persisted setting.
An invalid URL must safely return false and keep the existing request behavior.

- [ ] **Step 5: Run focused green tests**

```powershell
node tests/model_adapter_smoke.js
node tests/model_parser_resilience_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/model_settings_smoke.js
git diff --check
```

Expected: every command exits 0; all new request-body assertions pass and the
existing malformed/empty/retry cases remain green.

- [ ] **Step 6: Commit the product change**

```powershell
git add -- src/adapters/models/openai_compatible.js tests/model_adapter_smoke.js
git commit -m "fix: disable DeepSeek thinking for job extraction"
$candidateProductCommit=(git rev-parse HEAD).Trim()
```

Record the resulting hash as `$candidateProductCommit`.

### Task 2: Verify offline and run one fresh complete saved-JD flow

**Files:**

- Create:
  `docs/superpowers/reports/2026-07-29-deepseek-nonthinking-preflight.md`
- Create after the private run:
  `docs/superpowers/reports/2026-07-29-deepseek-nonthinking-live.md`
- No private input or result is committed.

- [ ] **Step 1: Run the full offline gate**

```powershell
node tests/model_adapter_smoke.js
node tests/model_parser_resilience_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/model_settings_smoke.js
node tests/private_full_chain_runner_smoke.js
$env:NODE_NO_WARNINGS='1'
npm.cmd test
git diff --check
git status --short
```

Expected: all targeted tests pass, all 47 registered offline checks pass,
`git diff --check` has no output, and only the planned preflight report is
uncommitted after it is written.

- [ ] **Step 2: Write and commit the safe preflight report**

Record only commit hashes, test command results, the four request-body
conditions and safety-boundary confirmation. Do not include prompts, request
bodies beyond the fixed `thinking` field, JD/resume text, model settings or
secrets.

```powershell
git add -- docs/superpowers/reports/2026-07-29-deepseek-nonthinking-preflight.md
git commit -m "docs: record DeepSeek non-thinking preflight"
$candidateEvaluatedCommit=(git rev-parse HEAD).Trim()
```

Record this descendant commit as `$candidateEvaluatedCommit`. The product
commit must be its strict ancestor so the private harness can distinguish
product behavior from the evaluated checkout.

- [ ] **Step 3: Create a fresh cache-empty private root**

```powershell
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v31-deepseek-nonthinking-single-20260729'
$frozen='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
if(Test-Path -LiteralPath $root){ throw "Private output already exists: $root" }
New-Item -ItemType Directory -Path (Join-Path $root 'input') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'labels') -Force | Out-Null
foreach($relative in @(
  'input\confirmed-card.private.json',
  'input\confirmed-profile.private.json',
  'input\identity.private.json',
  'input\jobs.private.json',
  'input\parse-report.json',
  'input\resume.redacted.txt',
  'labels\jobs.reviewed.json'
)){
  $destination=Join-Path $root $relative
  Copy-Item -LiteralPath (Join-Path $frozen $relative) -Destination $destination
}
```

Expected: only frozen input and reviewed labels are copied. No cache, database,
model output or previous run directory is copied.

- [ ] **Step 4: Initialize the manifest and portability proof offline**

```powershell
$candidateWorktree='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$baselineWorktree='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-empty-response-v1'
$baselineProductCommit='fb0168afce265cf351f03e80f66d9e0f24015887'
$sourceEvidence='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root $root `
  --baseline-worktree $baselineWorktree `
  --candidate-worktree $candidateWorktree `
  --baseline-product-commit $baselineProductCommit `
  --candidate-product-commit $candidateProductCommit `
  --output (Join-Path $root 'run-manifest.json')
if($LASTEXITCODE -ne 0){ throw 'Manifest initialization failed' }
node scripts/private-full-chain-runner.js --create-portability-proof `
  --source-private-root $sourceEvidence `
  --private-root $root `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
if($LASTEXITCODE -ne 0){ throw 'Portability proof failed' }
```

Expected: both commands exit 0 without loading model settings or making a model
call. The manifest binds the exact product and evaluated commits.

- [ ] **Step 5: Run exactly one complete candidate diagnostic**

The user has already granted `ALLOW_PRIVATE_RESUME_BENCHMARK=YES` and
`ALLOW_LIVE_MODEL_BENCHMARK=YES` for this saved-JD diagnostic.

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
node scripts/private-full-chain-runner.js --match-live `
  --private-root $root `
  --side candidate `
  --profile (Join-Path $root 'input\confirmed-profile.private.json') `
  --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
  --jobs (Join-Path $root 'input\jobs.private.json') `
  --labels (Join-Path $root 'labels\jobs.reviewed.json') `
  --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --diagnostic-indices 0 `
  --output (Join-Path $root 'runs\candidate')
if($LASTEXITCODE -ne 0){ throw 'Single-row live diagnostic failed' }
```

Do not start a second row or a 20-row run. If the process fails, preserve the
fresh root and inspect only safe aggregate telemetry; do not print response
content.

- [ ] **Step 6: Evaluate speed and quality together**

The one-row result must satisfy all functional conditions:

- exactly one row, saved job index 0;
- both `understandJob` and `matchJob` complete;
- `modelCallCount === 2`;
- `contractRepairCount === 0`;
- `failed`, `pending`, `stale` and `partial` are all zero;
- `matchingCardConsumed === true`;
- evidence-bearing output remains complete;
- no hard blocker is invented.

Report separately:

- `understandJob` elapsed time, attempts and safe failure metadata;
- `matchJob` elapsed time, attempts and safe failure metadata;
- total analysis time;
- final `roleAlignment`, foundation state, recommendation and bucket;
- comparison with the pre-change real evidence:
  - ordinary flow: about 120.3 seconds, two timeouts;
  - thinking-disabled full extraction probe: about 13.8 seconds and contract
    validation passed;
  - 90-second/4,096-token thinking-on probe: about 73.7 seconds and truncated.

The result is not accepted merely because it is fast. The expected quality
reference for frozen index 0 is a front-end-centered AI role whose role
foundation was previously judged unproven and placed in `backup`; any different
result must be shown to the user with evidence-category summaries before a
batch run is considered.

- [ ] **Step 7: Record the live result without exposing private content**

Create
`docs/superpowers/reports/2026-07-29-deepseek-nonthinking-live.md` containing
only safe aggregate fields, commit hashes, test results, acceptance decision
and remaining risk. Do not commit the private bundle or quote the JD, resume,
prompt or model response.

```powershell
git add -- docs/superpowers/reports/2026-07-29-deepseek-nonthinking-live.md
git commit -m "docs: record DeepSeek non-thinking live diagnostic"
```

If the one-row gate passes, stop and ask whether to proceed to a larger
comparison. If it fails, stop and diagnose that failure before any repeat.
