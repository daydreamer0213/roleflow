# DeepSeek V4 Flash Thinking and Prompt Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改现有四档二维表、70/30 权重、岗位分析 JSON 契约和提示词的前提下，把岗位分析切换到 `deepseek-v4-flash` 的显式思考模式，并用同一份人工确认的 20 条岗位池验证默认沟通集合无遗漏、无误入。

**Architecture:** 模型设置层保存“模型、思考开关、推理强度”；适配器层把它翻译为 DeepSeek 官方请求字段；分析修订和缓存层把完整推理配置纳入身份；私有 runner 把“冻结候选证据的生成模型身份”和“本轮岗位匹配模型身份”分开绑定。旧 v3 证明保持原语义，新跨模型实验使用新版本证明，不能通过一个宽泛跳过开关绕过门禁。

**Tech Stack:** Node.js CommonJS、原生 `fetch`、JSON 文件设置、SQLite 模型缓存、Node `assert` 冒烟测试、PowerShell、私有 full-chain runner。

## Global Constraints

- 不访问真实 BOSS，不点击沟通，不读取 Cookie，不读写 `D:\Guo\ZhiPing\data\jobs.sqlite`，不启动或操作 8787。
- 正式模型配置只在 live 步骤由 runner 从 `D:\Guo\ZhiPing` 读取；不得打印、复制、提交 API key 或配置原文。
- 私有输入和输出只写 `D:\DevData\RoleFlow-private-benchmark`；不得覆盖旧目录。
- 冻结岗位池固定为 `D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`。
- `jobs.private.json` 原始 SHA-256 必须为 `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`。
- `jobs.reviewed.json` 原始 SHA-256 必须为 `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`。
- 三条诊断索引固定为零基 `4,9,10`，不得再减一。
- 三条缓存不得用于 20 条；思考模式与非思考模式也不得共享缓存。
- 第一阶段只切换模型和推理配置。四档二维表、70/30 权重、职责/要求字段、提示词、JSON Output 契约和调用拆分保持不变。
- 正式通过门禁是行为边界，不是四档 exact：人工 `primary/apply` 必须仍为 `primary/apply`；人工 `caution/not_recommended` 不得进入 `primary/apply`。
- `primary` 与 `apply` 互换只记录；`caution` 与 `not_recommended` 互换记录为中度偏差；不阻断行为验收。
- 任何结构错误、空响应、旧缓存命中、隐私门禁失败或确认链失败都阻断后续 live 阶段。
- 不修改或合并 `main`；所有实现和 checkpoint 保留在当前 `codex/` 分支并及时 push。

---

### Task 1: 保存并展示显式 DeepSeek 推理配置

**Files:**
- Modify: `src/core/model_settings.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/model_settings_smoke.js`
- Modify: `tests/model_settings_ui_smoke.js`

**Interfaces:**
- Persist: `thinkingMode: "enabled" | "disabled"`
- Persist: `reasoningEffort: "high" | "max"`
- Runtime model config exposes both fields without exposing secrets.
- Existing configurations migrate to `thinkingMode: "disabled"` and `reasoningEffort: "high"` to preserve current behavior.

- [ ] **Step 1: Write failing settings tests**

Add tests proving that DeepSeek V4 accepts and persists:

```js
const saved = await saveVerifiedModelConfiguration(root, {
  preset: "deepseek-v4",
  model: "deepseek-v4-flash",
  thinkingMode: "enabled",
  reasoningEffort: "high",
  apiKey: "test-only-key"
});

assert.equal(saved.thinkingMode, "enabled");
assert.equal(saved.reasoningEffort, "high");
assert.equal(
  modelConfigFromSettings(root).providers.deepseek.thinkingMode,
  "enabled"
);
```

Also assert:

```js
assert.throws(
  () => normalizeThinkingMode("sometimes"),
  /MODEL_THINKING_MODE_INVALID/
);
assert.throws(
  () => normalizeReasoningEffort("medium"),
  /MODEL_REASONING_EFFORT_INVALID/
);
```

The connection probe captured body must contain:

```js
assert.deepEqual(body.thinking, { type: "disabled" });
assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
```

- [ ] **Step 2: Run focused RED tests**

Run:

```powershell
node tests/model_settings_smoke.js
node tests/model_settings_ui_smoke.js
```

Expected: failures for missing persisted fields, missing UI controls, and missing explicit non-thinking connection probe.

- [ ] **Step 3: Implement strict normalization and persistence**

In `src/core/model_settings.js`:

```js
const THINKING_MODES = new Set(["enabled", "disabled"]);
const REASONING_EFFORTS = new Set(["high", "max"]);

function normalizeThinkingMode(value, fallback = "disabled") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!THINKING_MODES.has(normalized)) {
    throw new Error("MODEL_THINKING_MODE_INVALID");
  }
  return normalized;
}

function normalizeReasoningEffort(value, fallback = "high") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error("MODEL_REASONING_EFFORT_INVALID");
  }
  return normalized;
}
```

Persist these fields, expose them through `modelConfigFromSettings()`, and include them in `modelFingerprint()`. Do not put API keys or secret-store contents in the fingerprint.

Keep `testModelConnection()` deliberately small and non-thinking:

```js
body.thinking = { type: "disabled" };
delete body.reasoning_effort;
```

- [ ] **Step 4: Add dashboard controls**

In `src/dashboard/server.js`, add:

```html
<select name="thinkingMode">
  <option value="disabled">关闭思考（当前兼容模式）</option>
  <option value="enabled">开启思考</option>
</select>
<select name="reasoningEffort">
  <option value="high">高</option>
  <option value="max">最高</option>
</select>
```

Only show the controls for official DeepSeek V4 presets. Disable the effort selector while thinking is disabled. The server remains authoritative and validates both values even if browser-side validation is bypassed.

- [ ] **Step 5: Run focused GREEN tests and commit**

Run:

```powershell
node tests/model_settings_smoke.js
node tests/model_settings_ui_smoke.js
```

Expected: both scripts pass; rendered HTML and runtime settings contain `deepseek-v4-flash`, `enabled`, and `high`; no secret appears in HTML or returned runtime settings.

Commit:

```powershell
git add src/core/model_settings.js src/dashboard/server.js tests/model_settings_smoke.js tests/model_settings_ui_smoke.js
git commit -m "feat: configure DeepSeek thinking mode"
```

---

### Task 2: Translate settings into stable DeepSeek API requests

**Files:**
- Modify: `src/adapters/models/openai_compatible.js`
- Modify: `tests/model_adapter_smoke.js`

**Interfaces:**
- Official DeepSeek V4 + enabled: `thinking.type=enabled`, selected `reasoning_effort`, no `temperature`.
- Official DeepSeek V4 + disabled: `thinking.type=disabled`, existing deterministic `temperature` behavior remains.
- Non-DeepSeek models and custom compatible endpoints receive no DeepSeek-only fields.
- Repair calls use the same selected inference mode as their parent call.

- [ ] **Step 1: Write a request-policy RED matrix**

Capture all request bodies and assert:

```js
for (const body of flashThinkingBodies) {
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(Object.hasOwn(body, "temperature"), false);
}

assert.deepEqual(flashNonThinkingBody.thinking, { type: "disabled" });
assert.equal(flashNonThinkingBody.temperature, 0);
assert.equal(Object.hasOwn(customEndpointBody, "thinking"), false);
assert.equal(Object.hasOwn(customEndpointBody, "reasoning_effort"), false);
```

Force one malformed top-level response and one malformed split response so that repair request bodies are included in `flashThinkingBodies`.

- [ ] **Step 2: Run the adapter RED test**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: current adapter still disables thinking and/or sends `temperature`, so the new matrix fails.

- [ ] **Step 3: Implement one centralized request policy**

Replace kind-specific implicit thinking restoration with one helper:

```js
function applyDeepSeekInferencePolicy(body, {
  officialDeepSeek,
  deepSeekV4,
  thinkingMode,
  reasoningEffort
}) {
  if (!officialDeepSeek || !deepSeekV4) return body;
  body.thinking = { type: thinkingMode };
  if (thinkingMode === "enabled") {
    body.reasoning_effort = reasoningEffort;
    delete body.temperature;
  } else {
    delete body.reasoning_effort;
  }
  return body;
}
```

Apply it after the common request body and JSON Output fields are assembled. Do not read or persist `message.reasoning_content`; continue parsing only `message.content`.

- [ ] **Step 4: Run the adapter GREEN test and commit**

Run:

```powershell
node tests/model_adapter_smoke.js
```

Expected: enabled, disabled, repair, non-DeepSeek, and custom endpoint cases all pass.

Commit:

```powershell
git add src/adapters/models/openai_compatible.js tests/model_adapter_smoke.js
git commit -m "feat: support explicit DeepSeek thinking requests"
```

---

### Task 3: Isolate caches and saved analyses by full inference identity

**Files:**
- Modify: `src/core/analysis_revision.js`
- Modify: `src/core/job_analysis.js`
- Modify: `tests/semantic_pipeline_smoke.js`

**Interfaces:**
- Stable inference identity includes provider, normalized endpoint, model, thinking mode, and reasoning effort.
- It excludes API keys, passwords, tokens, headers, and raw settings.
- A changed inference identity makes a saved analysis stale with `model_inference_changed`.
- It also changes the model cache key before any cached output can be returned.

- [ ] **Step 1: Write failing revision and cache tests**

Add:

```js
const disabled = modelInferenceVersion({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinkingMode: "disabled",
  reasoningEffort: "high"
});
const enabled = modelInferenceVersion({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinkingMode: "enabled",
  reasoningEffort: "high"
});

assert.notEqual(disabled, enabled);
assert.deepEqual(
  analysisStaleReasons({ modelInferenceVersion: disabled }, { modelInferenceVersion: enabled }),
  ["model_inference_changed"]
);
```

Exercise `cachedModelCall()` twice with the same provider/model/kind/input but different thinking mode. Assert the injected model function is called twice. Assert neither the revision nor cache metadata contains a known fake API key.

- [ ] **Step 2: Run the RED test**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: revision equality or a cache hit demonstrates missing inference isolation.

- [ ] **Step 3: Implement the sanitized inference version**

In `src/core/analysis_revision.js`:

```js
function modelInferenceVersion(config = {}) {
  return stableSha256({
    provider: normalizeProvider(config.provider),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model: String(config.model || "").trim(),
    thinkingMode: normalizeThinkingMode(config.thinkingMode),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort)
  });
}
```

Add it to `buildAnalysisRevision()`. A legacy saved revision without this field becomes stale once with `model_inference_changed`; this prevents old Pro output from silently surviving the first Flash run.

In `src/core/job_analysis.js`, include the version in the cache key:

```js
const cacheKey = [
  provider,
  model,
  inferenceVersion,
  kind,
  pipelineVersion,
  inputHash
].join("|");
```

- [ ] **Step 4: Run the GREEN test and commit**

Run:

```powershell
node tests/semantic_pipeline_smoke.js
```

Expected: all semantic pipeline checks pass, mode changes miss old caches, and no secret enters revisions.

Commit:

```powershell
git add src/core/analysis_revision.js src/core/job_analysis.js tests/semantic_pipeline_smoke.js
git commit -m "fix: isolate model inference revisions"
```

---

### Task 4: Separate frozen evidence identity from match execution identity

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-deepseek-v4-flash-thinking-prompt-optimization-design.md`
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Existing `confirmed-evidence-portability.v3` behavior remains unchanged.
- Add `confirmed-evidence-portability.v4` for a cross-model match experiment.
- v4 binds `evidenceModelIdentitySha256` to the existing confirmed profile/card envelopes.
- v4 separately binds `matchModelIdentitySha256` to the current sanitized model configuration.
- v4 cannot be used by profile-live or card-live; it authorizes only match-live with exact frozen candidate artifacts.

- [ ] **Step 1: Record the clarified threat model in the design**

Add a section explaining:

- A confirmed profile/card proves facts extracted and confirmed under its original evidence-generation model.
- Switching only the downstream matching model must not force those confirmed facts to be regenerated.
- The old evidence model identity remains immutable and verified.
- The new match model identity is separately HMAC-bound, included in the manifest, and checked immediately before match-live.
- A local administrator who can rewrite proof, manifest, all files, and the HMAC key remains outside the existing threat model.

- [ ] **Step 2: Write v4 RED tests**

Add smoke cases covering:

```js
assert.equal(v4Proof.evidenceModelIdentitySha256, proEvidenceIdentity);
assert.equal(v4Proof.matchModelIdentitySha256, flashThinkingIdentity);
assert.notEqual(
  v4Proof.evidenceModelIdentitySha256,
  v4Proof.matchModelIdentitySha256
);
```

Also assert:

- v3 still rejects a changed current model identity.
- v4 accepts match-live only when all four frozen evidence files are byte-identical and the profile/card envelopes agree on the evidence model identity.
- changing `thinkingMode` or `reasoningEffort` after proof creation rejects before model invocation.
- tampering either identity hash rejects HMAC/integrity verification.
- v4 rejects profile-live and card-live.
- API keys do not affect or appear in either public identity object.

- [ ] **Step 3: Run the runner RED test**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: v4 schema and phase-specific identity assertions fail because only one model identity exists.

- [ ] **Step 4: Implement v4 without weakening v3**

Keep the current `sanitizedModelIdentity()` and secret filtering. Add separate manifest/preflight fields:

```js
modelIdentity: {
  evidenceModelIdentitySha256,
  matchModelIdentitySha256
}
```

The v4 match-live preflight order is:

1. Verify HMAC and schema.
2. Verify source and target Git checkpoints and shared blobs.
3. Verify exact frozen candidate artifact hashes.
4. Verify profile/card confirmation envelopes against `evidenceModelIdentitySha256`.
5. Re-read current model settings once, hash the exact in-memory object, and compare with `matchModelIdentitySha256`.
6. Pass that same already-hashed in-memory model config to the model adapter.

Do not assign the full preflight object into itself. `preflight.portability` must be a new, explicit non-circular summary object.

- [ ] **Step 5: Run the runner GREEN test and commit**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: v3 compatibility, v4 cross-model isolation, tamper checks, single-read/hash-and-use, and non-circular report serialization all pass.

Commit:

```powershell
git add docs/superpowers/specs/2026-08-04-deepseek-v4-flash-thinking-prompt-optimization-design.md scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "test: bind match model separately from frozen evidence"
```

---

### Task 5: Run full offline verification and independent review

**Files:**
- Review all files changed in Tasks 1-4.
- Update only if review finds an Important or Critical issue.

- [ ] **Step 1: Run all focused tests**

Run:

```powershell
node tests/model_settings_smoke.js
node tests/model_settings_ui_smoke.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/private_full_chain_runner_smoke.js
```

Expected: all focused scripts pass.

- [ ] **Step 2: Run the complete offline suite**

Run:

```powershell
npm.cmd test
git diff --check
```

Expected: all repository checks pass and `git diff --check` prints nothing.

- [ ] **Step 3: Perform independent read-only review**

Review separately for:

- Spec compliance.
- Secret leakage.
- DeepSeek enabled/disabled request semantics.
- Repair-call consistency.
- Cache and saved-analysis isolation.
- v3 backward compatibility.
- v4 tamper resistance and single-read/hash-and-use.
- Non-circular preflight serialization.

If an Important or Critical finding exists, first add a failing regression, then fix, rerun focused and full offline tests, and repeat review. Do not proceed to live runs until `Spec PASS` and `Code quality APPROVED`.

- [ ] **Step 4: Commit the reviewed checkpoint and push**

Update the implementation plan with exact product and reviewed checkpoint SHAs, then:

```powershell
git add docs/superpowers/plans/2026-08-04-deepseek-v4-flash-thinking-prompt-optimization.md
git commit -m "docs: record reviewed Flash thinking checkpoint"
git push
```

Expected: current branch is clean and its upstream contains the reviewed checkpoint. `main` remains untouched.

---

### Task 6: Run the frozen three-job Flash thinking diagnostic

**Private roots:**
- Create: `D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804`
- Preserve every prior benchmark directory.

- [ ] **Step 1: Verify frozen raw hashes before creating output**

Run a hash-only PowerShell check. Do not print private file contents:

```powershell
$pool = 'D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730'
$jobsHash = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'input\jobs.private.json')).Hash.ToLowerInvariant()
$labelsHash = (Get-FileHash -Algorithm SHA256 (Join-Path $pool 'labels\jobs.reviewed.json')).Hash.ToLowerInvariant()
if ($jobsHash -ne '612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b') { throw 'JOBS_RAW_SHA_MISMATCH' }
if ($labelsHash -ne '97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39') { throw 'LABELS_RAW_SHA_MISMATCH' }
```

Expected: no output and exit code 0. Any mismatch stops the experiment immediately.

- [ ] **Step 2: Select Flash thinking without exposing credentials**

Set only non-secret fields in the existing RoleFlow model settings:

```text
model = deepseek-v4-flash
thinkingMode = enabled
reasoningEffort = high
```

Use the verified settings save path so the existing secret store remains separate. Confirm readiness by sanitized fields only; never print the raw settings file or API key.

- [ ] **Step 3: Create a new private root and v4 proof**

Copy the four frozen candidate evidence files byte-for-byte, plus the frozen jobs and labels. Initialize a new manifest at the reviewed candidate checkpoint and create the v4 portability proof with:

```text
evidence model identity = original confirmed profile/card identity
match model identity = deepseek-v4-flash + enabled + high
```

The target root must not exist before this step.

- [ ] **Step 4: Run exactly the three zero-based indices**

Run:

```powershell
node scripts/private-full-chain-runner.js --match-live `
  --private-root 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804' `
  --side candidate `
  --profile 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\input\confirmed-profile.private.json' `
  --matching-card 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\input\confirmed-card.private.json' `
  --jobs 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\input\jobs.private.json' `
  --labels 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\labels\jobs.reviewed.json' `
  --portability-proof 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\input\confirmed-evidence-portability.json' `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --diagnostic-indices '4,9,10' `
  --output 'D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-3-v1-20260804\runs\candidate'
```

Expected: three fresh model results, no old cache hit, all technical/privacy/structure gates pass.

- [ ] **Step 5: Publish a stage report in Chinese**

Report every job with English fields followed by Chinese explanations:

```text
index（零基索引）
title（岗位名称）
expectedRecommendation（人工确认档位）
actualRecommendation（模型与代码最终档位）
expectedCommunication（人工是否应默认沟通）
actualCommunication（实际是否进入默认沟通）
modelEvidence（模型提取的关键证据）
localDecision（本地二维表和量化规则如何裁决）
deviationSeverity（偏差严重程度）
```

If all three satisfy the behavior boundary, continue to Task 7.

If a job has a technical/structure/empty-response failure, stop at the first failing job and fix that root cause before any 20-run.

If only behavioral classification fails, run the same three in a new non-thinking root with `thinkingMode=disabled`, keeping model, prompt, contract, jobs, labels, and indices unchanged. Compare thinking versus non-thinking before editing prompts.

---

### Task 7: Run the independent 20-job Flash acceptance

**Private root:**
- Create: `D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-thinking-high-first-20-v1-20260804`

- [ ] **Step 1: Recheck settings and create an entirely fresh root**

Recompute the two frozen SHA-256 values. Create a new manifest, v4 proof, and empty output/cache directories. Do not copy any result or cache from Task 6.

- [ ] **Step 2: Run all 20 jobs**

Run the same `--match-live` command without `--diagnostic-indices`, using only paths under the new 20-job root.

Expected technical gates:

- 20 structurally valid responses.
- 0 empty responses.
- 0 privacy failures.
- 0 stale or cross-mode cache hits.
- Evidence identity and match identity both pass.

- [ ] **Step 3: Evaluate the behavior boundary**

Compute:

```text
communicationRecall = retained expected primary/apply / all expected primary/apply
communicationFalsePositives = expected caution/not_recommended predicted primary/apply
```

Acceptance requires:

```text
communicationRecall = 100%
communicationFalsePositives = 0
```

Do not require 18/20 exact.

- [ ] **Step 4: Publish the full stage report**

Show all deviations, not only failures. Explain whether each deviation came from:

- `modelEvidence（模型语义证据）`
- `decisionMatrix（二维表）`
- `weightedScore（量化权重）`
- `hardCeiling（安全封顶）`
- `responseStructure（响应结构）`

Do not change the two-dimensional matrix without user confirmation. If the behavior boundary passes and no severe technical defect exists, freeze the result instead of continuing open-ended prompt tuning.

---

### Task 8: Freeze, document, and push the accepted checkpoint

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-deepseek-v4-flash-thinking-prompt-optimization.md`
- Modify only if results justify it: `docs/roleflow-decision-matrix.md`
- Create under private root: final sanitized report artifacts.

- [ ] **Step 1: Record exact evidence**

Document:

- Product commit.
- Evaluated checkpoint.
- Runner/proof schema version.
- Frozen jobs and labels hashes.
- Flash model, thinking mode, and reasoning effort.
- Three-job root and result.
- Twenty-job root and result.
- Communication recall and false positives.
- Four-tier exact only as a secondary observation.
- Every known residual deviation.

- [ ] **Step 2: Run final repository verification**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: full offline suite passes, diff check is clean, and only intended documentation/checkpoint files are pending.

- [ ] **Step 3: Independent final review**

Require:

```text
Critical: 0
Important: 0
Spec: PASS
Code quality: APPROVED
```

- [ ] **Step 4: Commit and push**

Run:

```powershell
git add docs/superpowers/plans/2026-08-04-deepseek-v4-flash-thinking-prompt-optimization.md
git commit -m "docs: freeze Flash thinking acceptance"
git push
```

Expected: accepted checkpoint is present on the current GitHub branch; `main` is unchanged and no merge is performed.

## Plan Self-Review

- [ ] Every design requirement maps to a task and a named file.
- [ ] Every implementation task starts with a failing regression.
- [ ] DeepSeek-only request fields cannot leak to custom OpenAI-compatible endpoints.
- [ ] Enabled thinking never sends `temperature`.
- [ ] Repair calls cannot silently change thinking mode.
- [ ] Settings, revision, cache, manifest, and proof all bind thinking mode and reasoning effort.
- [ ] v3 remains backward compatible; v4 does not become a general identity bypass.
- [ ] Frozen evidence bytes remain unchanged across the model comparison.
- [ ] The 3-run and 20-run use different new roots and different caches.
- [ ] No command reads or prints secrets.
- [ ] No step accesses BOSS, jobs.sqlite, Cookies, or port 8787.
- [ ] The matrix cannot be changed without explicit user confirmation.
- [ ] There are no `TBD`, `TODO`, placeholders, or unspecified output paths.
