# DeepSeek Adaptive Match Thinking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep ordinary official DeepSeek V4 job matching fast by disabling thinking on the initial request, while restoring default thinking for the existing contract-repair request and validating quality on the frozen 20-job private fixture.

**Architecture:** The adapter makes one request-body decision from the existing `kind` and `input.contractRepair` values. No new retry or model stage is introduced. Real-model validation is staged: offline tests, a three-job stop/go diagnostic, one 20-job candidate run, and an offline overlap comparison against the nine usable default-thinking cache pairs.

**Tech Stack:** Node.js 22, CommonJS, built-in `node:test`-style smoke scripts using `assert`, Git worktrees, built-in SQLite, existing private full-chain runner.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab` except for the fixed candidate worktree switch and private artifacts explicitly listed below.
- Do not access BOSS, a browser, `D:\Guo\ZhiPing\data\jobs.sqlite`, the 8787 workbench, cookies, or communication actions.
- Use formal model settings only through the existing runner argument `--model-settings-root D:\Guo\ZhiPing`.
- Never print, commit or push resume text, JD text, prompts, response bodies, credentials or formal settings content.
- Keep private inputs and outputs below `D:\DevData\RoleFlow-private-benchmark`.
- Do not add dependencies, settings, migrations, timeouts, retries, prompts or model stages.
- A failed three-job diagnostic stops the plan before any 20-job run.
- Preserve the fixed candidate worktree branch and HEAD and restore them after every live run.
- Product quality remains recall-first: a defensible `talk` or `backup` result is not a failure merely because an exact historical bucket differs.

---

### Task 1: Make contract repair restore DeepSeek thinking

**Files:**
- Modify: `tests/model_adapter_smoke.js:556-609`
- Modify: `src/adapters/models/openai_compatible.js:260-269`
- Modify: `src/adapters/models/openai_compatible.js:553-565`

**Interfaces:**
- Consumes: `OpenAICompatibleAdapter.chatJson(systemPrompt, input, {kind})`.
- Produces: `shouldDisableDeepSeekThinking(baseUrl, model, kind, input) -> boolean`.
- Behavior: initial official DeepSeek V4 `matchJob` returns `true`; the same request with `input.contractRepair` returns `false`.

- [ ] **Step 1: Add the failing request-body test**

Extend the existing `deepSeekRequestBodies` loop with an explicit input value:

```js
for (const [adapterBaseUrl, model, kind, input] of [
  ["https://api.deepseek.com", "deepseek-v4-pro", "understandJob", { test: true }],
  ["https://api.deepseek.com", "deepseek-v4-flash", "understandJob", { test: true }],
  ["https://api.deepseek.com", "deepseek-v4-pro", "matchJob", { test: true }],
  [
    "https://api.deepseek.com",
    "deepseek-v4-pro",
    "matchJob",
    {
      test: true,
      contractRepair: {
        reason: "synthetic contract failure",
        invalidOutput: { matches: [] }
      }
    }
  ],
  ["https://api.deepseek.com", "other-model", "understandJob", { test: true }],
  ["https://example.invalid", "deepseek-v4-pro", "understandJob", { test: true }],
  ["not-a-valid-url", "deepseek-v4-pro", "understandJob", { test: true }]
]) {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: adapterBaseUrl,
    apiKey: "test-key",
    model,
    jsonMode: false,
    maxRetries: 0,
    logger
  });
  assert.deepStrictEqual(
    await adapter.chatJson("return json", input, { kind }),
    { ok: true }
  );
}
```

After the existing initial-match assertion, add:

```js
assert(
  !Object.prototype.hasOwnProperty.call(deepSeekRequestBodies[3], "thinking"),
  "official DeepSeek V4 contract repair must restore default thinking"
);
for (const payload of deepSeekRequestBodies.slice(4)) {
  assert(
    !Object.prototype.hasOwnProperty.call(payload, "thinking"),
    "other models, custom endpoints, and invalid URLs must keep their existing request body"
  );
}
```

- [ ] **Step 2: Run the focused test and verify the red failure**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: exit 1 because `deepSeekRequestBodies[3]` still contains
`thinking: {type: "disabled"}`.

- [ ] **Step 3: Implement the minimum request-body condition**

Pass `input` into the existing predicate:

```js
if (shouldDisableDeepSeekThinking(this.baseUrl, this.model, kind, input)) {
  body.thinking = { type: "disabled" };
}
```

Replace the helper with:

```js
function shouldDisableDeepSeekThinking(baseUrl, model, kind, input) {
  if ((kind !== "understandJob" && kind !== "matchJob")
    || (kind === "matchJob" && input?.contractRepair)
    || !DEEPSEEK_V4_MODELS.has(String(model || "").trim().toLowerCase())) {
    return false;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the focused test and verify green**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: `model_adapter_smoke ok`, exit 0.

- [ ] **Step 5: Run the complete offline regression**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected:

- `All 47 offline checks passed`;
- `git diff --check` has no output;
- status lists only the adapter and adapter smoke test.

- [ ] **Step 6: Commit the product change**

```powershell
git add -- src/adapters/models/openai_compatible.js tests/model_adapter_smoke.js
git commit -m "fix: restore DeepSeek thinking for match repairs"
$env:ADAPTIVE_PRODUCT_COMMIT=(git rev-parse HEAD).Trim()
```

Expected: `ADAPTIVE_PRODUCT_COMMIT` is the new product commit hash.

---

### Task 2: Freeze a clean live-evaluation commit

**Files:**
- No file changes.

**Interfaces:**
- Consumes: `ADAPTIVE_PRODUCT_COMMIT` from Task 1.
- Produces: `ADAPTIVE_EVALUATED_COMMIT`, a clean direct descendant used by private manifests.

- [ ] **Step 1: Reverify the committed product**

Run:

```powershell
node tests/model_adapter_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: focused test and all 47 offline checks pass; worktree is clean.

- [ ] **Step 2: Create an empty evaluated-commit marker**

```powershell
git commit --allow-empty -m "test: prepare adaptive DeepSeek match acceptance"
$env:ADAPTIVE_EVALUATED_COMMIT=(git rev-parse HEAD).Trim()
$env:ADAPTIVE_PRODUCT_COMMIT=(git rev-parse HEAD^).Trim()
git rev-list --parents -n 1 $env:ADAPTIVE_EVALUATED_COMMIT
```

Expected: the new commit has exactly one parent, `ADAPTIVE_PRODUCT_COMMIT`.
Keep both environment variables for Tasks 3-4.

---

### Task 3: Run the three-job stop/go diagnostic

**Files:**
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v34-deepseek-adaptive-match-thinking-3-20260729\**`
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728\input\**`
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\**`

**Interfaces:**
- Consumes: `ADAPTIVE_PRODUCT_COMMIT`, `ADAPTIVE_EVALUATED_COMMIT`.
- Produces: a three-row `runs\candidate\match-result.json`.

- [ ] **Step 1: Verify the target is new and both worktrees are clean**

```powershell
$experiment='D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab'
$fixed='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v34-deepseek-adaptive-match-thinking-3-20260729'
if(Test-Path -LiteralPath $root){throw "Private target already exists: $root"}
git -C $experiment status --porcelain
git -C $fixed status --porcelain
git -C $fixed rev-parse HEAD
git -C $fixed branch --show-current
```

Expected: both status commands are empty. Record the fixed worktree branch as
`codex/claude-generic-evidence-matching-live-fix` and HEAD as
`1fc49dac3670a71c720bfcaed943fa29204d93c5`.

- [ ] **Step 2: Prepare the private input bundle**

Create `input`, `labels`, `runs\candidate` and `reports` under `$root`. Copy
only these files from the v28 source:

```powershell
$source='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
New-Item -ItemType Directory -Path `
  (Join-Path $root 'input'), `
  (Join-Path $root 'labels'), `
  (Join-Path $root 'runs\candidate'), `
  (Join-Path $root 'reports') | Out-Null
$files=@(
  'input\confirmed-card.private.json',
  'input\confirmed-profile.private.json',
  'input\identity.private.json',
  'input\jobs.private.json',
  'input\parse-report.json',
  'input\resume.redacted.txt',
  'labels\jobs.reviewed.json'
)
foreach($relative in $files){
  Copy-Item -LiteralPath (Join-Path $source $relative) `
    -Destination (Join-Path $root $relative)
}
```

Expected: exactly seven input/label files exist; do not print their contents.

- [ ] **Step 3: Temporarily bind the fixed candidate worktree**

```powershell
git -C $fixed switch --detach $env:ADAPTIVE_EVALUATED_COMMIT
git -C $fixed status --porcelain
git -C $fixed rev-parse HEAD
```

Expected: clean detached HEAD exactly equals `ADAPTIVE_EVALUATED_COMMIT`.
From this point, if any command fails, run Task 3 Step 6 before stopping.

- [ ] **Step 4: Create and verify the manifest and portability proof**

```powershell
Push-Location $fixed
try {
  node scripts/private-full-chain-runner.js --init-manifest `
    --private-root $root `
    --baseline-worktree 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-empty-response-v1' `
    --candidate-worktree $fixed `
    --baseline-product-commit 'fb0168afce265cf351f03e80f66d9e0f24015887' `
    --candidate-product-commit $env:ADAPTIVE_PRODUCT_COMMIT `
    --output (Join-Path $root 'run-manifest.json')

  node scripts/private-full-chain-runner.js --create-portability-proof `
    --source-private-root 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725' `
    --private-root $root `
    --output (Join-Path $root 'input\confirmed-evidence-portability.json')

  node scripts/private-full-chain-runner.js --verify-private-bundle `
    --private-root $root `
    --resume-text (Join-Path $root 'input\resume.redacted.txt') `
    --identity (Join-Path $root 'input\identity.private.json') `
    --parse-report (Join-Path $root 'input\parse-report.json')
} finally {
  Pop-Location
}
```

Expected: all three commands exit 0 without printing private content.

- [ ] **Step 5: Run indices 0, 10 and 14 serially**

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
Push-Location $fixed
try {
  node scripts/private-full-chain-runner.js --match-live `
    --private-root $root `
    --side candidate `
    --profile (Join-Path $root 'input\confirmed-profile.private.json') `
    --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
    --jobs (Join-Path $root 'input\jobs.private.json') `
    --labels (Join-Path $root 'labels\jobs.reviewed.json') `
    --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
    --model-settings-root 'D:\Guo\ZhiPing' `
    --diagnostic-indices '0,10,14' `
    --output (Join-Path $root 'runs\candidate')
} finally {
  Pop-Location
}
```

Expected: exit 0 and exactly three result rows.

- [ ] **Step 6: Restore the fixed candidate worktree before inspection**

```powershell
git -C $fixed switch codex/claude-generic-evidence-matching-live-fix
git -C $fixed rev-parse HEAD
git -C $fixed status --porcelain
```

Expected: HEAD is
`1fc49dac3670a71c720bfcaed943fa29204d93c5` and status is empty.

- [ ] **Step 7: Apply the three-row stop/go gate**

Read only the safe result fields. Require:

```text
total=3
failed=0
pending=0
partial=0
every row semanticStatus=complete
every row evidenceComplete=true
every row hardBlocked=false
index 0 roleAlignment=misaligned
index 0 foundationState=unproven
index 0 actualBucket=backup
index 10 contractRepairCount=1
```

If any requirement fails, stop and report. Do not execute Task 4.

---

### Task 4: Run the 20-job hybrid candidate

**Files:**
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v35-deepseek-adaptive-match-thinking-20-20260729\**`

**Interfaces:**
- Consumes: the passing Task 3 commits and the same frozen private inputs.
- Produces: one complete 20-row hybrid `match-result.json`.

- [ ] **Step 1: Prepare a fresh v35 bundle**

```powershell
$fixed='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v35-deepseek-adaptive-match-thinking-20-20260729'
$source='D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728'
if(Test-Path -LiteralPath $root){throw "Private target already exists: $root"}
if(git -C $fixed status --porcelain){throw "Fixed candidate worktree is dirty"}
New-Item -ItemType Directory -Path `
  (Join-Path $root 'input'), `
  (Join-Path $root 'labels'), `
  (Join-Path $root 'runs\candidate'), `
  (Join-Path $root 'reports') | Out-Null
$files=@(
  'input\confirmed-card.private.json',
  'input\confirmed-profile.private.json',
  'input\identity.private.json',
  'input\jobs.private.json',
  'input\parse-report.json',
  'input\resume.redacted.txt',
  'labels\jobs.reviewed.json'
)
foreach($relative in $files){
  Copy-Item -LiteralPath (Join-Path $source $relative) `
    -Destination (Join-Path $root $relative)
}
git -C $fixed switch --detach $env:ADAPTIVE_EVALUATED_COMMIT
if(git -C $fixed status --porcelain){throw "Detached fixed worktree is dirty"}
node "$fixed\scripts\private-full-chain-runner.js" --init-manifest `
  --private-root $root `
  --baseline-worktree 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-empty-response-v1' `
  --candidate-worktree $fixed `
  --baseline-product-commit 'fb0168afce265cf351f03e80f66d9e0f24015887' `
  --candidate-product-commit $env:ADAPTIVE_PRODUCT_COMMIT `
  --output (Join-Path $root 'run-manifest.json')
node "$fixed\scripts\private-full-chain-runner.js" --create-portability-proof `
  --source-private-root 'D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725' `
  --private-root $root `
  --output (Join-Path $root 'input\confirmed-evidence-portability.json')
node "$fixed\scripts\private-full-chain-runner.js" --verify-private-bundle `
  --private-root $root `
  --resume-text (Join-Path $root 'input\resume.redacted.txt') `
  --identity (Join-Path $root 'input\identity.private.json') `
  --parse-report (Join-Path $root 'input\parse-report.json')
```

Expected: the new root contains the seven copied inputs, manifest and
portability proof. All three runner commands exit 0. If any command fails,
restore the fixed worktree with Task 4 Step 3 before stopping.

- [ ] **Step 2: Run all 20 rows**

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
Push-Location $fixed
try {
  node scripts/private-full-chain-runner.js --match-live `
    --private-root $root `
    --side candidate `
    --profile (Join-Path $root 'input\confirmed-profile.private.json') `
    --matching-card (Join-Path $root 'input\confirmed-card.private.json') `
    --jobs (Join-Path $root 'input\jobs.private.json') `
    --labels (Join-Path $root 'labels\jobs.reviewed.json') `
    --portability-proof (Join-Path $root 'input\confirmed-evidence-portability.json') `
    --model-settings-root 'D:\Guo\ZhiPing' `
    --output (Join-Path $root 'runs\candidate')
} finally {
  Pop-Location
}
```

Expected: exit 0 and `match-result.json` contains 20 rows. Run serially; do not
start another model or browser process.

- [ ] **Step 3: Restore the fixed candidate worktree**

```powershell
git -C $fixed switch codex/claude-generic-evidence-matching-live-fix
if((git -C $fixed rev-parse HEAD).Trim() -ne '1fc49dac3670a71c720bfcaed943fa29204d93c5'){
  throw "Fixed candidate HEAD was not restored"
}
if(git -C $fixed status --porcelain){throw "Restored fixed worktree is dirty"}
```

Expected: the original branch and exact original HEAD are restored before
reading results.

- [ ] **Step 4: Apply the 20-row reliability and recall gate**

Require:

```text
total=20
failed=0
pending=0
partial=0
falseHardExclusion=0
primaryWithoutEvidence=0
unresolvedDisposition=0
```

For every row labelled `keep`, reject `skip`, `not_recommended` or
`hardBlocked=true`. For every row labelled `exclude`, require
`skip/not_recommended`.

Calculate from rows:

```js
const matchLatencies = rows.map((row) => row.matchJobLatencyMs).sort((a, b) => a - b);
const medianMatchLatencyMs = (matchLatencies[9] + matchLatencies[10]) / 2;
const slowestMatchLatencyMs = matchLatencies.at(-1);
const totalAnalysisElapsedMs = rows.reduce((sum, row) => sum + row.analysisElapsedMs, 0);
```

Require `medianMatchLatencyMs <= 30000` and at least a 40% reduction from the
observed default-thinking median of 57,436 ms.

---

### Task 5: Reconstruct and compare the nine cached default-thinking rows offline

**Files:**
- Read only: `D:\DevData\RoleFlow-private-benchmark\full-chain-v32-deepseek-nonthinking-20-20260729\runs\candidate\model-cache.sqlite`
- Create outside Git: `D:\DevData\RoleFlow-private-benchmark\full-chain-v35-deepseek-adaptive-match-thinking-20-20260729\reports\default-thinking-overlap.json`

**Interfaces:**
- Consumes: the v32 cache and v35 candidate rows.
- Produces: a safe overlap report containing indices and decision fields only.

- [ ] **Step 1: Copy the interrupted cache into v35**

```powershell
$sourceDb='D:\DevData\RoleFlow-private-benchmark\full-chain-v32-deepseek-nonthinking-20-20260729\runs\candidate\model-cache.sqlite'
$replayDb='D:\DevData\RoleFlow-private-benchmark\full-chain-v35-deepseek-adaptive-match-thinking-20-20260729\reports\default-thinking-cache.copy.sqlite'
$sourceRoot='D:\DevData\RoleFlow-private-benchmark\full-chain-v32-deepseek-nonthinking-20-20260729'
$running=Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$sourceRoot*"
}
if($running){throw "Interrupted v32 runner is still active"}
Copy-Item -LiteralPath $sourceDb -Destination $replayDb
foreach($suffix in @('-wal','-shm')){
  if(Test-Path -LiteralPath "$sourceDb$suffix"){
    Copy-Item -LiteralPath "$sourceDb$suffix" -Destination "$replayDb$suffix"
  }
}
@'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], {readOnly: true});
const counts = Object.fromEntries(
  db.prepare("SELECT kind, COUNT(*) count FROM model_cache GROUP BY kind")
    .all()
    .map((row) => [row.kind, Number(row.count)])
);
db.close();
if (counts.understandJob !== 15 || counts.matchJob !== 9) {
  throw new Error(`Unexpected cache counts: ${JSON.stringify(counts)}`);
}
console.log("default-thinking cache counts ok");
'@ | node - $replayDb
```

Expected: the source process is absent and the copied SQLite/WAL/SHM set prints
`default-thinking cache counts ok`.

- [ ] **Step 2: Replay with an injected no-network analyzer**

Run this offline probe from PowerShell:

```powershell
$fixed='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
$root='D:\DevData\RoleFlow-private-benchmark\full-chain-v35-deepseek-adaptive-match-thinking-20-20260729'
$replayDb=Join-Path $root 'reports\default-thinking-cache.copy.sqlite'
$overlap=Join-Path $root 'reports\default-thinking-overlap.json'
@'
const fs = require("node:fs");
const path = require("node:path");

const fixed = process.argv[2];
const root = process.argv[3];
const replayDb = process.argv[4];
const output = process.argv[5];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const { loadConfigs } = require(path.join(fixed, "src", "config"));
const { profileToRuntimeConfigs } = require(path.join(fixed, "src", "core", "search_plan"));
const { createJobAnalysisRunner } = require(path.join(fixed, "src", "core", "job_analysis"));
const { scoreJob, decisionState } = require(path.join(fixed, "src", "core", "scoring"));
const { openDb, decisionBucket } = require(path.join(fixed, "src", "core", "storage"));
const {
  decisionHardBlockers,
  roleEvidenceDecisionState
} = require(path.join(fixed, "src", "core", "model_contract"));

const profileEnvelope = readJson(path.join(root, "input", "confirmed-profile.private.json"));
const cardEnvelope = readJson(path.join(root, "input", "confirmed-card.private.json"));
const jobs = readJson(path.join(root, "input", "jobs.private.json"));
const candidateResult = readJson(path.join(root, "runs", "candidate", "match-result.json"));
if (!Array.isArray(jobs) || jobs.length !== 20
  || !Array.isArray(candidateResult.rows) || candidateResult.rows.length !== 20) {
  throw new Error("Expected one frozen 20-job fixture and one 20-row candidate result.");
}

const profile = profileEnvelope.profile;
const card = cardEnvelope.card;
const directions = Array.isArray(profile?.candidate?.targetTitles)
  ? profile.candidate.targetTitles.filter(Boolean)
  : [];
const city = String(profile?.candidate?.city || "").trim();
const searchPlan = {
  name: "Private full-chain benchmark",
  cities: city ? [city] : [],
  salary: {minK: 0, maxK: 0},
  salaryMode: "wide",
  experience: ["经验不限", "0-3年", "1-3年", "3-5年（可冲）"],
  allowExperienceStretch: true,
  jobTypes: ["全职"],
  directions,
  keywords: directions.map((word) => ({
    word,
    priority: "A",
    reason: "confirmed private profile"
  })),
  bossActiveDays: 3,
  workSchedulePreference: "prefer_double_weekend",
  excludeWords: [],
  hardExcludes: []
};
const base = loadConfigs(fixed);
const configs = profileToRuntimeConfigs({
  ...base,
  model: {
    provider: "openai_compatible",
    providers: {
      openai_compatible: {
        model: "deepseek-v4-pro",
        baseUrl: "",
        apiKey: ""
      }
    }
  },
  candidateProfile: profile
}, profile, searchPlan, null, card);

let cacheMissCount = 0;
const cacheMiss = async () => {
  cacheMissCount += 1;
  const error = new Error("CACHE_MISS_NO_NETWORK");
  error.code = "CACHE_MISS_NO_NETWORK";
  throw error;
};
const noNetworkAnalyzer = {
  understandJob: cacheMiss,
  matchJob: cacheMiss
};
let events = [];
const logger = {
  info: (event) => events.push(event),
  warn: (event) => events.push(event)
};

const db = openDb(replayDb);
const baselineRows = [];
try {
  const analyze = createJobAnalysisRunner(configs, searchPlan.keywords, {
    db,
    analyzer: noNetworkAnalyzer,
    logger
  });
  for (let index = 0; index < jobs.length; index += 1) {
    events = [];
    const missesBefore = cacheMissCount;
    const job = jobs[index];
    const benchmarkJob = {
      ...job,
      source: "boss",
      bossActiveText: "今日活跃",
      detailRequired: true,
      detailRead: true
    };
    const scored = scoreJob(benchmarkJob, configs);
    const state = decisionState(scored);
    if (state !== "ready") continue;
    const analysisJob = {
      ...job,
      source: "boss",
      detailRequired: true,
      detailRead: true,
      ...scored
    };
    const analysis = await analyze(analysisJob);
    const cacheHits = events.filter((event) => event === "model_cache_hit").length;
    if (cacheHits !== 2 || cacheMissCount !== missesBefore) continue;
    const roleState = roleEvidenceDecisionState(analysis);
    baselineRows.push({
      index,
      semanticStatus: String(analysis.semanticStatus || ""),
      recommendation: String(analysis.recommendation || ""),
      bucket: decisionBucket({...analysisJob, analysis}),
      roleAlignment: String(analysis.roleAlignment || ""),
      foundationState: String(roleState.foundationState || ""),
      evidenceComplete: Boolean(analysis.evidence?.jd?.length && analysis.evidence?.resume?.length),
      hardBlocked: decisionHardBlockers(analysis).length > 0
    });
  }
} finally {
  db.close();
}
if (baselineRows.length !== 9) {
  throw new Error(`Expected nine complete cache pairs, got ${baselineRows.length}.`);
}

const incomplete = new Set(["failed", "pending", "partial", "stale"]);
const pairs = baselineRows.map((baseline) => {
  const candidateRow = candidateResult.rows[baseline.index];
  const candidate = {
    semanticStatus: candidateRow.semanticStatus,
    recommendation: candidateRow.actualRecommendation,
    bucket: candidateRow.actualBucket,
    roleAlignment: candidateRow.roleAlignment,
    foundationState: candidateRow.foundationState,
    evidenceComplete: candidateRow.evidenceComplete,
    hardBlocked: candidateRow.hardBlocked
  };
  return {
    index: baseline.index,
    baseline,
    candidate,
    changed: {
      recommendation: baseline.recommendation !== candidate.recommendation,
      bucket: baseline.bucket !== candidate.bucket,
      roleAlignment: baseline.roleAlignment !== candidate.roleAlignment,
      foundationState: baseline.foundationState !== candidate.foundationState,
      hardBlocked: baseline.hardBlocked !== candidate.hardBlocked
    },
    automaticRegression: (
      (!incomplete.has(baseline.semanticStatus) && incomplete.has(candidate.semanticStatus))
      || (!baseline.hardBlocked && candidate.hardBlocked)
    )
  };
});
const report = {
  runMode: "offline-cache-overlap",
  providerInitialized: false,
  formalSettingsRead: false,
  overlapTotal: pairs.length,
  automaticRegressionCount: pairs.filter((row) => row.automaticRegression).length,
  pairs
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx"
});
console.log(JSON.stringify({
  overlapTotal: report.overlapTotal,
  automaticRegressionCount: report.automaticRegressionCount,
  cacheMissCount
}));
'@ | node - $fixed $root $replayDb $overlap
```

Expected:

- `overlapTotal` is 9;
- `automaticRegressionCount` is 0;
- the probe never calls `resolveRuntimeModelConfig`, constructs
  `OpenAICompatibleAdapter`, reads formal settings or initializes a provider;
- the report contains only numeric indices, enums and booleans.

- [ ] **Step 3: Review decision changes**

Read `default-thinking-overlap.json` and count changes in recommendation,
bucket, role alignment and foundation state. Reject the adaptive strategy if a
baseline-complete row becomes incomplete, a new hard blocker appears, or the
changed role-direction rows show a systematic semantic regression. Do not
require exact recommendation/bucket equality.

---

### Task 6: Record the decision and push the experiment branch

**Files:**
- Create: `docs/superpowers/reports/2026-07-29-deepseek-adaptive-match-thinking-live.md`

**Interfaces:**
- Consumes: Task 3, Task 4 and Task 5 safe aggregates.
- Produces: a Git-safe acceptance report and final keep/revert decision.

- [ ] **Step 0: Revert the match-thinking experiment if a gate failed**

Run this step only if Task 3, 4 or 5 rejected adaptive thinking:

```powershell
git revert --no-edit $env:ADAPTIVE_PRODUCT_COMMIT
git revert --no-edit 0efd308f876a1060c216ca77b152421bc551ef78
node tests/model_adapter_smoke.js
npm.cmd test
```

Expected: both reverts commit successfully, the adapter returns to the
understand-only non-thinking behavior from `1fc49da`, and all 47 offline checks
pass. Skip this step when all acceptance gates pass.

- [ ] **Step 1: Write the safe report**

Include:

- `ADAPTIVE_PRODUCT_COMMIT` and `ADAPTIVE_EVALUATED_COMMIT`;
- three-row status and timings;
- 20-row reliability, recall and latency aggregates;
- nine-row overlap counts and decision-field change counts;
- whether each acceptance condition passed;
- final decision: keep adaptive thinking or revert the match-thinking
  experiment;
- confirmation that no private text, response body, secret, BOSS access,
  database access or 8787 action occurred.

Do not include job IDs, titles, companies, JD text, resume text, evidence text,
model output or settings content.

- [ ] **Step 2: Run final verification**

```powershell
node tests/model_adapter_smoke.js
npm.cmd test
git diff --check
git status --short
```

Expected: all 47 offline checks pass; diff-check is clean; status contains only
the report.

- [ ] **Step 3: Commit and push**

```powershell
git add -- docs/superpowers/reports/2026-07-29-deepseek-adaptive-match-thinking-live.md
git commit -m "docs: record adaptive DeepSeek match acceptance"
git push
git status -sb
```

Expected: local and remote
`codex/deepseek-match-nonthinking-ab` are synchronized and the worktree is
clean. Do not create a pull request or merge into the primary optimization
branch.
