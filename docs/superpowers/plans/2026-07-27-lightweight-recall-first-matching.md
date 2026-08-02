# Lightweight Recall-first Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two-stage candidate matching pipeline decision-minimal so a single job finishes near the approved baseline cost without weakening evidenced hard exclusions or strongest-bucket evidence.

**Architecture:** Keep the reusable `understandJob -> matchJob` boundary. Normalize a compact job-understanding response into the existing internal shape, then accept sparse evidence-bearing match rows and derive unknowns and recommendations locally. Remove duplicated per-job model inputs instead of adding concurrency or a new subsystem.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing smoke-test scripts, SQLite model cache, existing OpenAI-compatible adapter.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`.
- Do not access BOSS, any recruitment platform, a browser, `D:\Guo\ZhiPing\data\jobs.sqlite`, or port 8787.
- Do not add dependencies or a database migration.
- An omitted or invalid soft field must never become a hard exclusion.
- `skip` still requires a verified eligibility or indispensable-core conflict with JD and resume evidence, or the existing safety guard.
- `primary` still requires complete JD and resume evidence.
- Do not resume the paused 20-row candidate run.
- Private live output must stay under `D:\DevData\RoleFlow-private-benchmark`.

---

### Task 1: Compact job understanding

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/model_contract.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: `validateModelResult("understandJob", rawValue)`.
- Produces: the existing normalized `JobUnderstanding` fields, with stable `R*` and `E*` IDs, from `{roleSummary,requirements,eligibility,riskSignals}`.

- [ ] **Step 1: Write failing prompt and normalization tests**

Add assertions that the prompt requires only:

```js
requirements: [{ label: "核心要求", indispensable: false, evidence: "JD：原文" }],
eligibility: ["JD：明确硬资格"],
riskSignals: [{ type: "fee_fraud", severity: "high", evidence: "JD：收费原文" }]
```

Assert that it does not request `coreResponsibilities`, `preferredRequirements`, `outcomeExpectations`, `senioritySignal`, `evidenceSnippets`, or nested `jobQuality.concerns`.

Add a compact validator case:

```js
const compact = validateModelResult("understandJob", {
  roleSummary: "交付应用",
  requirements: [{ label: "独立交付", indispensable: true, evidence: "JD：独立交付应用" }],
  eligibility: ["JD：本科及以上"],
  riskSignals: []
});
assert.strictEqual(compact.coreRequirements[0].id, "R1");
assert.strictEqual(compact.eligibilityItems[0].id, "E1");
assert.deepStrictEqual(compact.preferredRequirements, []);
assert.deepStrictEqual(compact.jobQuality, { level: "normal", concerns: [] });
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: prompt assertions fail because the old verbose fields remain, and compact validation does not yet recognize `requirements`.

- [ ] **Step 3: Implement the compact prompt and normalizer**

In `OpenAICompatibleAdapter.understandJob`, replace the verbose prompt with a short instruction for the four compact fields. Preserve:

- JD-only evidence;
- the existing conservative definition of `indispensable`;
- explicit eligibility only;
- responsibility-sprawl as a low/medium risk signal;
- fee, fraud, safety, or compliance as a high risk signal;
- 120-character evidence limits and bounded arrays;
- one contract-repair instruction.

In `validateJobUnderstanding`, detect the compact shape with:

```js
if (Object.prototype.hasOwnProperty.call(value, "requirements")
  || Object.prototype.hasOwnProperty.call(value, "eligibility")
  || Object.prototype.hasOwnProperty.call(value, "riskSignals")) {
  return validateCompactJobUnderstanding(value);
}
```

Normalize compact values into the existing shape. Derive `jobQuality.level` as `risk` for any high signal, `caution` for any other signal, otherwise `normal`. Map risk signals to both `hiddenRisks` and `jobQuality.concerns`. Default compatibility-only arrays to `[]`.

Bump `PIPELINE_VERSIONS.understandJob` from `job-understanding-v9` to `job-understanding-v10`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```powershell
git add -- tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js src/adapters/models/openai_compatible.js src/core/model_contract.js src/core/analysis_revision.js
git commit -m "perf: compact job understanding contract"
```

### Task 2: Sparse match evidence and deduplicated input

**Files:**
- Modify: `tests/model_adapter_smoke.js`
- Modify: `tests/semantic_pipeline_smoke.js`
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `src/core/job_analysis.js`
- Modify: `src/core/model_contract.js`
- Modify: `src/core/analysis_revision.js`

**Interfaces:**
- Consumes: `validateModelResult("matchJob", rawValue, { jobUnderstanding })`.
- Produces: the existing normalized `MatchDecision` from sparse `{matches,eligibility}` evidence.

- [ ] **Step 1: Write failing sparse-contract and input tests**

Assert the analyzer receives no `resumeVersions` and no `jobEvidence`:

```js
assert(!Object.prototype.hasOwnProperty.call(seenMatchInput, "resumeVersions"));
assert(!Object.prototype.hasOwnProperty.call(seenMatchInput, "jobEvidence"));
```

Assert sparse output is conservative:

```js
const result = validateModelResult("matchJob", {
  matches: [{ id: "R1", state: "matched", resumeEvidence: "简历：已有直接项目事实" }],
  eligibility: []
}, { jobUnderstanding });
assert.strictEqual(result.requirementMatches.find((item) => item.requirement === "未返回的要求").state, "unknown");
assert.strictEqual(result.recommendation, "review");
```

Retain failure cases for invented IDs, duplicated IDs, invalid states, unprefixed evidence, and unsupported explicit conflicts.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected: sparse coverage fails on missing IDs, and model input still contains duplicated fields.

- [ ] **Step 3: Implement sparse matching**

Replace the match prompt with only:

```json
{
  "matches": [{"id":"R1","state":"matched","resumeEvidence":"简历：事实"}],
  "eligibility": [{"id":"E1","state":"conflict","resumeEvidence":"简历：冲突事实"}]
}
```

The prompt must state:

- output only evidence-bearing rows;
- omit unknown rows;
- `missing` is allowed only with explicit incompatibility evidence;
- `conflict` is allowed only with an explicit candidate fact;
- user notes guide preference but never count as resume evidence;
- no recommendation, confidence, cautions, uncertainties, or copied JD output.

Change compact evidence coverage from exact to sparse. Build all normalized requirements and eligibility items locally; IDs absent from model output become `{state:"unknown",resumeEvidence:""}`. Keep duplicate, invented-ID, enum, evidence-prefix, and deterministic conflict validation.

Derive confidence locally:

- `0.9` when all extracted requirements and eligibility are resolved and there is positive direct evidence;
- `0.72` when there is positive evidence but transferable or soft gaps remain;
- `0.45` when no positive evidence or unknowns remain.

Keep the current recommendation order: verified blocker -> skip; unknown/no positive evidence/risk -> review; transferable/non-core gap/caution quality -> caution; complete direct evidence -> apply.

Remove `resumeVersions` and `jobEvidence` from the match input in `createJobAnalysisRunner`. Keep candidate profile, confirmed matching card, compact understanding, and small search preferences.

Bump `PIPELINE_VERSIONS.matchJob` from `match-decision-v18` to `match-decision-v19`.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```powershell
git add -- tests/model_adapter_smoke.js tests/semantic_pipeline_smoke.js src/adapters/models/openai_compatible.js src/core/job_analysis.js src/core/model_contract.js src/core/analysis_revision.js
git commit -m "perf: make match evidence sparse"
```

### Task 3: Offline regression and one-row live diagnostic

**Files:**
- Create: `docs/superpowers/reports/2026-07-27-lightweight-single-row-diagnostic.md`
- Create private output outside Git under `D:\DevData\RoleFlow-private-benchmark`.

**Interfaces:**
- Consumes: the existing private runner `--diagnostic-indices 1`.
- Produces: one non-acceptance candidate result and aggregate timing comparison.

- [ ] **Step 1: Run the full offline gate**

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: all offline checks pass, diff-check is clean, and only planned committed changes exist.

- [ ] **Step 2: Create a fresh private diagnostic run directory**

Use a new directory under:

```text
D:\DevData\RoleFlow-private-benchmark\full-chain-v20-lightweight-single-20260727
```

Copy only the already frozen private benchmark bundle needed by the existing runner. Do not print or edit private contents. Update the private run manifest to the new candidate commit using the existing privacy-safe manifest workflow.

- [ ] **Step 3: Run only frozen index 1**

Run the existing candidate `match-live` command with:

- `ALLOW_PRIVATE_RESUME_BENCHMARK=YES`;
- `ALLOW_LIVE_MODEL_BENCHMARK=YES`;
- `--model-settings-root D:\Guo\ZhiPing`;
- `--diagnostic-indices 1`;
- the new candidate output directory.

Expected: exactly one row, `diagnosticMode:true`, `acceptanceEligible:false`. Do not run compare mode.

- [ ] **Step 4: Derive privacy-safe measurements**

Read only:

- cache `kind`, `created_at`, and `result_json` character length;
- result semantic status, recommendation, bucket, evidence completeness, blocker count, and safe error metadata.

Do not print any private content or identifier. Compare:

```text
old candidate same row: understand 357.47s, match 47.39s, total 404.86s
approved baseline successful-stage average: approximately 56s per two-stage job
```

- [ ] **Step 5: Decide the next gate**

Recommend another small optimization if the row fails, is falsely hard-excluded, or remains above roughly twice the baseline average. Recommend the 20-row acceptance comparison only if the row completes, preserves the user-confirmed keep disposition, has no evidence-free primary result, and shows a substantial latency reduction.

- [ ] **Step 6: Record and commit a non-private summary**

Add only aggregate values and the go/no-go recommendation to a report under `docs/superpowers/reports/`. Do not include title, company, JD, resume, IDs, endpoints, keys, or model names.

```powershell
git add -- docs/superpowers/reports/2026-07-27-lightweight-single-row-diagnostic.md
git commit -m "docs: record lightweight single-row diagnostic"
```
