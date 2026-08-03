# DeepSeek V4 Pro / Flash Isolated A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated, auditable benchmark that compares `deepseek-v4-pro` and `deepseek-v4-flash` on the same frozen recommendation inputs without changing the saved production model setting.

**Architecture:** Add a standalone private A/B runner rather than changing the existing code-version comparator. A small pure metrics module owns schedule, quality, latency, token and cost gates; the runner reads the verified runtime configuration once, clones it in memory with only the model name changed, then executes the unchanged production analysis pipeline serially against immutable private inputs. A narrow source-fixture loader validates existing confirmed profile/card provenance while intentionally treating it as fixed input rather than output of either target model.

**Tech Stack:** Node.js 22+, CommonJS, existing RoleFlow model adapter and analysis pipeline, SQLite model cache, Node `assert` smoke tests, private files under `D:\DevData\RoleFlow-private-benchmark`.

## Global Constraints

- Do not change `.runtime/settings/model.json`, encrypt/decrypt/copy a secret outside the existing runtime reader, or call any model-settings save API.
- The only permitted target models are exactly `deepseek-v4-pro` and `deepseek-v4-flash` on the official DeepSeek OpenAI-compatible endpoint.
- Use one clean product commit, one prompt/scoring implementation, one confirmed profile, one confirmed matching card and one frozen job/label fixture for both target models.
- Run serially, use a new SQLite model-analysis cache for every model/repetition, and never reuse a result cache between sides or repetitions.
- Require explicit `ALLOW_PRIVATE_MODEL_AB_BENCHMARK=YES`, preserve the existing private/live authorization checks, and fail before resolving model configuration when input/path/authorization gates fail.
- Read and write private benchmark data only below `D:\DevData\RoleFlow-private-benchmark`; do not write benchmark artifacts, caches or temporary data to `C:`.
- Never access BOSS, browser sessions/cookies, dashboard port 8787 or an operational jobs database.
- Persist only opaque IDs, hashes, bounded numbers, model names, safe enums and aggregate metrics. Do not persist or print API keys, endpoints, provider request IDs, resumes, JDs, titles, companies, URLs or model-response text.
- The formal fixture is recall-first and currently has no confirmed exclude rows. Report that precision limitation; do not use historical operational data as a quality baseline.
- Flash is eligible only when quality is non-inferior, Stage 2 median latency is at least 20% lower, and conservative estimated cost is at least 50% lower. Never switch the saved default model automatically.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/lib/model_ab_metrics.js` | Pure model-pair validation, schedule generation, usage normalization, conservative cost calculation, stage acceptance and safe report rendering. |
| `scripts/lib/private_model_ab_inputs.js` | Read-only validation of a confirmed private source bundle and extraction of fixed profile/card/job/label/resume inputs with hashes only in returned metadata. |
| `scripts/model-ab-benchmark.js` | Thin CLI/orchestrator: request gates, immutable manifest, in-memory model overrides, serial production-pipeline execution, fresh caches and private reports. |
| `tests/model_ab_benchmark_smoke.js` | Synthetic offline coverage for A/B gates, scheduling, privacy, source-input validation, telemetry and acceptance decisions. |
| `tests/run_all.js` | Registers the new offline smoke test. |
| `package.json` | Adds a focused `test:model-ab` script. |
| `docs/recommendation_casebook.md` | Documents that a private error case is diagnostic evidence and must not be converted into a direct model-run input without complete frozen evidence. |

The existing `scripts/private-full-chain-runner.js` remains the code-version benchmark. Do not add a Pro/Flash mode to it or weaken `comparePrivateFullChainResults()` / `runPrivateFullChain()` model-identity checks.

### Task 1: Build the pure A/B metrics and acceptance module

**Files:**

- Create: `scripts/lib/model_ab_metrics.js`
- Create: `tests/model_ab_benchmark_smoke.js`

**Interfaces:**

- Consumes: sanitized side-run records shaped as `{ modelIdentity, rows, evaluationCount, usage, latency, structural }`.
- Produces: `assertApprovedModelPair`, `assertComparableTargetIdentities`, `withModelOverride`, `diagnosticSchedule`, `normalizeUsage`, `estimateConservativeCost`, `assessDiagnosticStage`, `assessFormalStage`, and `renderModelAbMarkdown`.
- Later tasks rely on the exact statuses: `diagnostic_pass`, `quality_regression`, `run_incomplete`, `performance_inconclusive`, `cost_target_missed`, `cost_inconclusive`, and `flash_eligible`.

- [ ] **Step 1: Write failing metric and schedule tests**

  In `tests/model_ab_benchmark_smoke.js`, begin with synthetic sanitized records only. Cover the exact model pair, an invalid third model, immutable in-memory config cloning, the three-repetition alternating order, missing usage, and each acceptance status.

  ```js
  const assert = require("node:assert");
  const metrics = require("../scripts/lib/model_ab_metrics");

  assert.deepStrictEqual(
    metrics.diagnosticSchedule(),
    [
      { repetition: 1, model: "deepseek-v4-pro" },
      { repetition: 1, model: "deepseek-v4-flash" },
      { repetition: 2, model: "deepseek-v4-flash" },
      { repetition: 2, model: "deepseek-v4-pro" },
      { repetition: 3, model: "deepseek-v4-pro" },
      { repetition: 3, model: "deepseek-v4-flash" }
    ]
  );

  const base = { provider: "openai_compatible", providers: { openai_compatible: {
    baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", timeoutMs: 60000, apiKey: "synthetic-secret"
  } } };
  const flash = metrics.withModelOverride(base, "deepseek-v4-flash");
  assert.strictEqual(base.providers.openai_compatible.model, "deepseek-v4-pro");
  assert.strictEqual(flash.providers.openai_compatible.model, "deepseek-v4-flash");
  assert.throws(() => metrics.withModelOverride(base, "another-model"), /MODEL_AB_MODEL_PAIR/);
  metrics.assertApprovedModelPair(["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.throws(() => metrics.assertApprovedModelPair(["deepseek-v4-pro", "another-model"]), /MODEL_AB_MODEL_PAIR/);
  ```

- [ ] **Step 2: Run the focused test and confirm it fails for the missing module**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code non-zero with `Cannot find module '../scripts/lib/model_ab_metrics'`.

- [ ] **Step 3: Implement model-pair, usage and pricing helpers**

  Create `scripts/lib/model_ab_metrics.js`. Clone configuration without writing any file, require both approved model IDs exactly once, and remove secrets before identity comparison. Normalize only numeric provider usage received on `model_call_completed`; do not inspect request content or IDs.

  ```js
  const APPROVED_MODELS = Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]);
  const DIAGNOSTIC_INDICES = Object.freeze([5, 8, 13]);
  const PRICING = Object.freeze({
    currency: "USD",
    perMillionTokens: true,
    models: {
      "deepseek-v4-pro": { inputCacheMiss: 0.435, output: 0.87 },
      "deepseek-v4-flash": { inputCacheMiss: 0.14, output: 0.28 }
    }
  });

  function withModelOverride(modelConfig, model) {
    if (!APPROVED_MODELS.includes(model)) throw modelAbError("MODEL_AB_MODEL_PAIR", "Only the approved Pro/Flash pair is allowed.");
    const provider = String(modelConfig?.provider || "");
    const selected = modelConfig?.providers?.[provider];
    if (provider !== "openai_compatible" || !selected || selected.baseUrl !== "https://api.deepseek.com") {
      throw modelAbError("MODEL_AB_DEEPSEEK_REQUIRED", "The A/B benchmark requires the verified official DeepSeek configuration.");
    }
    return {
      ...modelConfig,
      providers: { ...modelConfig.providers, [provider]: { ...selected, model } }
    };
  }

  function assertApprovedModelPair(models) {
    if (!Array.isArray(models) || models.length !== 2 || new Set(models).size !== 2
      || [...models].sort().join("|") !== [...APPROVED_MODELS].sort().join("|")) {
      throw modelAbError("MODEL_AB_MODEL_PAIR", "The benchmark requires exactly DeepSeek V4 Pro and Flash.");
    }
    return [...models];
  }

  function assertComparableTargetIdentities(pro, flash) {
    const stableFields = ["provider", "endpointSha256", "timeoutMs", "requestSettingsWithoutModelSha256"];
    assertApprovedModelPair([pro?.model, flash?.model]);
    if (stableFields.some((field) => pro?.[field] !== flash?.[field])) {
      throw modelAbError("MODEL_AB_TARGET_IDENTITY", "Only the model name may differ between target configurations.");
    }
  }

  function normalizeUsage(usage) {
    const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens);
    const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens);
    if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) return null;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  function estimateConservativeCost(usage, rates) {
    if (!usage) return null;
    return (usage.inputTokens / 1_000_000) * rates.inputCacheMiss
      + (usage.outputTokens / 1_000_000) * rates.output;
  }

  function modelAbError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function median(values) {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function percentile95(values) {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
  }
  ```

- [ ] **Step 4: Implement deterministic scheduling and aggregate acceptance**

  Use the following shape. Treat a structural failure, failed/stale/pending/partial row, false hard exclusion, or expected-disposition violation as a quality failure. Require full 20-row coverage for formal acceptance before latency/cost checks.

  ```js
  function diagnosticSchedule() {
    return [
      ["deepseek-v4-pro", "deepseek-v4-flash"],
      ["deepseek-v4-flash", "deepseek-v4-pro"],
      ["deepseek-v4-pro", "deepseek-v4-flash"]
    ].flatMap((models, index) => models.map((model) => ({ repetition: index + 1, model })));
  }

  function assessFormalStage({ pro, flash, pricing }) {
    const qualityFailures = [...qualityFailuresFor(pro, "pro"), ...qualityFailuresFor(flash, "flash")];
    if (qualityFailures.length) return { accepted: false, status: "quality_regression", failureReasons: qualityFailures };
    if (pro.rows.length !== 20 || flash.rows.length !== 20) {
      return { accepted: false, status: "run_incomplete", failureReasons: ["Formal comparison requires 20 usable rows for each model."] };
    }
    const proMedian = median(pro.rows.map((row) => row.analysisElapsedMs));
    const flashMedian = median(flash.rows.map((row) => row.analysisElapsedMs));
    if (!(flashMedian <= proMedian * 0.8)) {
      return { accepted: false, status: "performance_inconclusive", failureReasons: ["Flash median latency is not at least 20% lower."] };
    }
    const proCost = totalCost(pro, pricing.models["deepseek-v4-pro"]);
    const flashCost = totalCost(flash, pricing.models["deepseek-v4-flash"]);
    if (proCost == null || flashCost == null) return { accepted: false, status: "cost_inconclusive", failureReasons: ["Completed-call token telemetry is incomplete."] };
    if (!(flashCost <= proCost * 0.5)) return { accepted: false, status: "cost_target_missed", failureReasons: ["Flash cost reduction is below 50%."] };
    return { accepted: true, status: "flash_eligible", failureReasons: [] };
  }

  function assessDiagnosticStage({ runs, indices }) {
    const expectedRunCount = 6;
    const rows = runs.flatMap((run) => run.rows);
    const failures = [
      ...(runs.length === expectedRunCount ? [] : ["Diagnostic schedule is incomplete."]),
      ...runs.filter((run) => run.rows.length !== indices.length || run.cacheHitCount !== 0)
        .map((run) => `Invalid diagnostic run: ${run.ordinal}.`),
      ...rows.flatMap((row) => qualityFailuresFor({ rows: [row] }, "diagnostic"))
    ];
    return failures.length
      ? { accepted: false, status: "quality_regression", failureReasons: [...new Set(failures)] }
      : { accepted: true, status: "diagnostic_pass", failureReasons: [] };
  }

  function qualityFailuresFor(run, side) {
    const badStatuses = new Set(["failed", "stale", "pending", "partial"]);
    return [
      ...(run.cacheHitCount === 0 ? [] : [`${side}: fresh cache violated`]),
      ...run.rows.flatMap((row) => {
      if (badStatuses.has(row.semanticStatus)) return [`${side}: structural status`];
      if (row.evidenceComplete !== true) return [`${side}: missing evidence`];
      if (row.expectedDisposition === "keep" && !["primary", "apply", "caution"].includes(row.actualBucket)) return [`${side}: opportunity not retained`];
      if (row.falseHardExclusion === true) return [`${side}: false hard exclusion`];
      if (row.pass !== true) return [`${side}: confirmed disposition mismatch`];
      return [];
      })
    ];
  }

  function totalCost(run, rates) {
    if (run.usageComplete !== true) return null;
    let total = 0;
    for (const row of run.rows) {
      const estimated = estimateConservativeCost(row.usage, rates);
      if (estimated == null) return null;
      total += estimated;
    }
    return total;
  }

  function assertSafeArtifact(value) {
    const forbidden = /^(?:apiKey|authorization|resumeText|description|company|title|url|content|providerRequestId)$/i;
    const walk = (item) => {
      if (Array.isArray(item)) return item.forEach(walk);
      if (!item || typeof item !== "object") return;
      for (const [key, child] of Object.entries(item)) {
        if (forbidden.test(key)) throw modelAbError("MODEL_AB_PRIVATE_OUTPUT", `Forbidden output field: ${key}`);
        walk(child);
      }
    };
    walk(value);
    return value;
  }
  ```

  Define `totalCost(run, rates)` to return `null` unless `run.usageComplete === true`, otherwise sum `estimateConservativeCost(row.usage, rates)` for all rows. `renderModelAbMarkdown(report)` must call `assertSafeArtifact(report)` before rendering and include median and `percentile95` latency only as numbers.

- [ ] **Step 5: Extend tests to cover boundary cases and sanitization**

  Add assertions for: a new Flash false hard exclusion, an added failed row, 19/20 coverage, median speed exactly 20% lower, 19% lower, missing input or output token count, 49% cost reduction, and report serialization that rejects fields named `apiKey`, `authorization`, `resumeText`, `description`, `company`, `title`, `url`, `content`, or `providerRequestId`.

  ```js
  const report = metrics.assessFormalStage({ pro: passingPro, flash: passingFlash, pricing: metrics.PRICING });
  assert.strictEqual(report.status, "flash_eligible");
  assert.strictEqual(metrics.assessFormalStage({ pro: passingPro, flash: slowerFlash, pricing: metrics.PRICING }).status, "performance_inconclusive");
  assert.strictEqual(metrics.assessFormalStage({ pro: passingPro, flash: missingUsageFlash, pricing: metrics.PRICING }).status, "cost_inconclusive");
  assert.throws(() => metrics.assertSafeArtifact({ apiKey: "synthetic-secret" }), /MODEL_AB_PRIVATE_OUTPUT/);
  ```

- [ ] **Step 6: Run the focused test and commit the pure module**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code 0 and a single success line from the smoke test.

  Commit:

  ```powershell
  git add scripts/lib/model_ab_metrics.js tests/model_ab_benchmark_smoke.js
  git commit -m "feat: add model A/B acceptance metrics"
  ```

### Task 2: Add a narrow confirmed-source fixture loader

**Files:**

- Create: `scripts/lib/private_model_ab_inputs.js`
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify: `tests/model_ab_benchmark_smoke.js`

**Interfaces:**

- Consumes: a canonical source private root containing its source `run-manifest.json`, confirmed profile/card, redacted resume/identity, frozen jobs and confirmed labels.
- Produces: `loadConfirmedSourceInputs({ sourcePrivateRoot, paths, assertResumeIdentityRedacted })` returning `{ profileInput, cardInput, fixture, resume, sourceIdentity }`.
- `sourceIdentity` contains only hashes and safe identifiers. It records the original profile/card model identity but does not require it to equal either A/B target model.
- The existing full-chain runner keeps its present model-identity equality checks unchanged.

- [ ] **Step 1: Write failing synthetic source-bundle tests**

  In `tests/model_ab_benchmark_smoke.js`, create a synthetic bundle below the approved private parent. Reuse only synthetic resume, jobs and labels. Assert that a valid source loads, changing any source manifest/profile/card/job/label hash rejects, an unredacted synthetic identity rejects, and no source text is present in `sourceIdentity`.

  ```js
  const inputs = require("../scripts/lib/private_model_ab_inputs");
  const loaded = inputs.loadConfirmedSourceInputs({
    sourcePrivateRoot: syntheticSourceRoot,
    paths: syntheticInputPaths,
    assertResumeIdentityRedacted: () => {}
  });
  assert.strictEqual(loaded.fixture.jobs.length, 3);
  assert.match(loaded.sourceIdentity.fixtureJobSetSha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(JSON.stringify(loaded.sourceIdentity).includes("synthetic JD text"), false);
  ```

- [ ] **Step 2: Run the focused test and confirm it fails for the missing loader**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code non-zero with `Cannot find module '../scripts/lib/private_model_ab_inputs'`.

- [ ] **Step 3: Export only the existing safe primitives needed for source validation**

  Do not export or alter `runPrivateFullChain()` / `comparePrivateFullChainResults()`. From `scripts/private-full-chain-runner.js`, export only the existing pure helpers required by the new loader:

  ```js
  module.exports = {
    // existing exports stay unchanged
    privateJobsAndLabels,
    confirmedProfileInput,
    confirmedCardInput,
    readNativeMatchInputs,
    readJsonFile,
    valueSha256,
    sha256,
    sanitizedModelIdentity,
    deriveRecallFirstMetrics,
    frozenBenchmarkScoreInput,
    canonicalPrivateActualRecommendation,
    canonicalPrivateLabel,
    ruleBlockedAnalysis,
    createPrivateTelemetryCollector
  };
  ```

  Keep these exports free of settings, browser, database or provider side effects. Add an assertion in `tests/private_full_chain_runner_smoke.js` that the existing full-chain comparison still rejects different `modelIdentitySha256` values.

- [ ] **Step 4: Implement source provenance validation without a target-model equality rule**

  In `scripts/lib/private_model_ab_inputs.js`, validate the source bundle’s own manifest and the confirmed profile/card against their original source context. Verify the redacted resume against the source identity. Then return fixed inputs and hashes. The specific exception is local to this function: `sourceModelIdentitySha256` is recorded, but it is never compared to the target Pro/Flash identities.

  ```js
  function readCanonicalJson(file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
      return value;
    } catch {
      throw privateInputError("MODEL_AB_SOURCE_INVALID", "Confirmed source inputs are missing or invalid.");
    }
  }

  function loadConfirmedSourceInputs({ sourcePrivateRoot, paths, assertResumeIdentityRedacted }) {
    const manifest = readCanonicalJson(path.join(sourcePrivateRoot, "run-manifest.json"));
    const context = {
      injected: false,
      manifest,
      runManifestSha256: valueSha256(manifest),
      side: "candidate",
      evaluatedCommit: manifest.candidateEvaluatedCommit
    };
    const raw = readNativeMatchInputs({ privateRoot: sourcePrivateRoot, ...paths }, assertResumeIdentityRedacted);
    const fixture = privateJobsAndLabels(raw.jobsValue, raw.labelsValue, raw.jobsRaw);
    const profileInput = confirmedProfileInput(raw.profileValue, context);
    const cardInput = confirmedCardInput(raw.cardValue, profileInput, context);
    return {
      profileInput,
      cardInput,
      fixture,
      resume: raw.resume,
      sourceIdentity: {
        sourceRunManifestSha256: context.runManifestSha256,
        sourceModelIdentitySha256: profileInput.envelope.modelIdentitySha256,
        fixtureProfileSha256: profileInput.profileSha256,
        fixtureMatchingCardSha256: cardInput.cardSha256,
        fixtureJobSetSha256: fixture.jobsSha256,
        fixtureLabelsSha256: fixture.labelsSha256,
        resumeContentSha256: profileInput.envelope.resumeContentSha256,
        identityManifestSha256: profileInput.envelope.identityManifestSha256
      }
    };
  }
  ```

  Define `privateInputError(code, message)` in this module exactly like the task-1 error factory, and ensure all parser errors use its constant safe message rather than raw JSON/parser text.

- [ ] **Step 5: Prove the source loader did not weaken the existing comparator**

  Run both focused test files. The first proves that fixed source inputs can be used by a distinct-model experiment; the second proves the existing code-version comparator still refuses model mismatch.

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  node tests/private_full_chain_runner_smoke.js
  ```

  Expected: both commands exit 0. No test may create artifacts outside its process-specific directory under `D:\DevData\RoleFlow-private-benchmark`.

- [ ] **Step 6: Commit the loader refactor**

  ```powershell
  git add scripts/private-full-chain-runner.js scripts/lib/private_model_ab_inputs.js tests/private_full_chain_runner_smoke.js tests/model_ab_benchmark_smoke.js
  git commit -m "feat: load confirmed inputs for model A/B tests"
  ```

### Task 3: Implement the isolated private A/B runner and stage gates

**Files:**

- Create: `scripts/model-ab-benchmark.js`
- Modify: `tests/model_ab_benchmark_smoke.js`

**Interfaces:**

- Consumes: the read-only runtime model settings root, a new target private root, a read-only confirmed source bundle and `pricingObservedAt`.
- Produces: `validateModelAbRequest`, `initializeModelAbManifest`, `runModelAbPhase`, `diagnoseCasebookAvailability`, `renderModelAbReport`, and a CLI with `--init`, `--live --phase diagnostic|formal`, `--casebook-diagnose`, and `--report`.
- Writes only these fixed target paths: `run-manifest.json`, for example `runs/diagnostic/01-deepseek-v4-pro/match-result.json` and its adjacent `model-cache.sqlite`, plus `reports/*.json` / `reports/*.md`. The phase and ordinal are validated values, not caller-chosen paths.

- [ ] **Step 1: Write failing CLI request-gate tests**

  Add tests that call `validateModelAbRequest` with injected dependencies. Each invalid case must fail before calling `resolveRuntimeModelConfig` or a provider:

  ```js
  const runner = require("../scripts/model-ab-benchmark");
  const authorized = {
    ALLOW_PRIVATE_MODEL_AB_BENCHMARK: "YES",
    ALLOW_PRIVATE_RESUME_BENCHMARK: "YES",
    ALLOW_LIVE_MODEL_BENCHMARK: "YES"
  };
  const result = runner.validateModelAbRequest({
    mode: "live", phase: "diagnostic", privateRoot: syntheticRunRoot,
    sourcePrivateRoot: syntheticSourceRoot, modelSettingsRoot: "D:\\Guo\\ZhiPing",
    pricingObservedAt: "2026-08-03T00:00:00.000Z", gitProof: { clean: true, commit: "1".repeat(40) }
  }, authorized, { resolveRuntimeModelConfig: () => { throw new Error("must not resolve during pure validation"); } });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(runner.validateModelAbRequest({ mode: "live" }, authorized).code, "MODEL_AB_PRIVATE_ROOT_REQUIRED");
  ```

  Cover missing/incorrect authorization, target path outside the approved parent, source equal to target, output root already initialized, home/temp/repository settings roots, dirty/mismatched commit proof, invalid ISO timestamp, unsupported phase and a source path with a reparse point.

- [ ] **Step 2: Run the focused test and confirm it fails for the missing runner**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code non-zero with `Cannot find module '../scripts/model-ab-benchmark'`.

- [ ] **Step 3: Implement request validation and manifest initialization**

  Create `scripts/model-ab-benchmark.js`. Implement the gates before reading settings or source contents. `--init` creates a fresh target root under the private parent and writes a write-once manifest. It must bind source hashes and price data but not local paths, JD/resume text, endpoint text or secrets.

  ```js
  const MODEL_AB_AUTH = "ALLOW_PRIVATE_MODEL_AB_BENCHMARK";
  const MODEL_AB_HARNESS_VERSION = "private-model-ab-harness.v1";

  function modelAbManifest({ evaluatedCommit, sourceIdentity, pricingObservedAt, harnessSha256 }) {
    return {
      runMode: "private-model-ab",
      harnessVersion: MODEL_AB_HARNESS_VERSION,
      evaluatedCommit,
      sourceIdentity,
      targets: ["deepseek-v4-pro", "deepseek-v4-flash"],
      diagnosticIndices: [...DIAGNOSTIC_INDICES],
      pricing: {
        sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
        observedAt: pricingObservedAt,
        currency: "USD",
        inputMode: "cache_miss_conservative",
        models: PRICING.models
      },
      harnessSha256
    };
  }

  function initializeModelAbManifest(request, deps) {
    const source = loadConfirmedSourceInputs(request.source);
    const manifest = modelAbManifest({
      evaluatedCommit: inspectCleanHead(deps.git, deps.cwd),
      sourceIdentity: source.sourceIdentity,
      pricingObservedAt: request.pricingObservedAt,
      harnessSha256: valueSha256(Object.fromEntries([
        __filename,
        path.join(__dirname, "lib", "model_ab_metrics.js"),
        path.join(__dirname, "lib", "private_model_ab_inputs.js")
      ].map((file) => [path.basename(file), sha256(fs.readFileSync(file))])))
    });
    exclusivePrivateWrite(request.privateRoot, path.join(request.privateRoot, "run-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  }
  ```

  Validate `isModelReady(resolveRuntimeModelConfig(...))` only during live execution. Validate the resolved provider, exact base URL, timeout and readable key, then create two configs using `withModelOverride`. Create each persisted target identity with the model-specific `model` plus a hash of request settings after removing both the API key and `model`; call `assertComparableTargetIdentities(proIdentity, flashIdentity)` before the first model call. Never call `saveModelSettings`, `saveVerifiedModelConfiguration` or a dashboard API.

- [ ] **Step 4: Implement one serial job evaluation with fresh cache and sanitized telemetry**

  Reuse the production pipeline exactly as `runPrivateFullChain()` does: `profileToRuntimeConfigs`, `createJobAnalysisRunner`, `scoreJob`, `decisionState`, `openDb`, `decisionBucket`, `mapWithConcurrency`, `decisionHardBlockers`, `roleEvidenceDecisionState`, `frozenBenchmarkScoreInput`, and `canonicalPrivateActualRecommendation`.

  Build a new A/B telemetry collector instead of changing production telemetry. Sum `data.usage` only for `model_call_completed`; do not use attempt events for usage and do not store `providerRequestId` or content.

  ```js
  function createModelAbTelemetry() {
    const values = { inputTokens: 0, outputTokens: 0, usageComplete: true, modelCallCount: 0, modelAttemptCount: 0,
      modelAttemptLatencyMs: 0, understandJobLatencyMs: 0, matchJobLatencyMs: 0, contractRepairCount: 0, emptyResponseAttemptCount: 0,
      cacheHitCount: 0 };
    const safeInteger = (value) => Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : 0;
    const collect = (event, data) => {
      if (event === "model_call_completed") {
        values.modelCallCount += 1;
        if (data?.cacheHit === true) values.cacheHitCount += 1;
        const usage = normalizeUsage(data?.usage);
        if (!usage) values.usageComplete = false;
        else { values.inputTokens += usage.inputTokens; values.outputTokens += usage.outputTokens; }
        if (data?.kind === "understandJob") values.understandJobLatencyMs += safeInteger(data.latencyMs);
        if (data?.kind === "matchJob") values.matchJobLatencyMs += safeInteger(data.latencyMs);
      }
      if (event === "model_call_attempt_completed" || event === "model_call_attempt_failed") {
        values.modelAttemptCount += 1;
        values.modelAttemptLatencyMs += safeInteger(data?.latencyMs);
      }
    };
    return {
      logger: { info: collect, warn: collect },
      snapshot: () => ({ ...values })
    };
  }
  ```

  For each `(phase, repetition, model)` use an output directory made from the ordinal and model name. Call `preparePrivateSqliteCache()` before analysis; a pre-existing cache is a hard error. Call `mapWithConcurrency(selectedJobs, 1, ...)` and retain only sanitized row fields used by the metrics module.

- [ ] **Step 5: Implement phase scheduling and immutable results**

  Diagnostic phase uses `DIAGNOSTIC_INDICES` and the exact `diagnosticSchedule()` order. Formal phase uses all 20 rows once per model in Pro then Flash order only after a prior diagnostic report has `status: "diagnostic_pass"` and `accepted: true`.

  ```js
  async function runModelAbPhase(request, deps) {
    const manifest = readAndVerifyManifest(request.privateRoot, request.sourcePrivateRoot, request.evaluatedCommit);
    const plan = request.phase === "diagnostic"
      ? diagnosticSchedule()
      : [{ repetition: 1, model: "deepseek-v4-pro" }, { repetition: 1, model: "deepseek-v4-flash" }];
    if (request.phase === "formal") assertDiagnosticAccepted(request.privateRoot);
    const runs = [];
    for (const entry of plan) {
      runs.push(await executeOneModelRun({ request, manifest, entry, deps }));
    }
    const assessment = request.phase === "diagnostic"
      ? assessDiagnosticStage({ runs, indices: DIAGNOSTIC_INDICES })
      : assessFormalStage({ pro: findModelRun(runs, "deepseek-v4-pro"), flash: findModelRun(runs, "deepseek-v4-flash"), pricing: manifest.pricing });
    writePhaseReports(request.privateRoot, request.phase, { manifest, runs, assessment });
    return assessment;
  }
  ```

  Write reports with exclusive creates. Always preserve a phase report on a quality/coverage failure, then exit non-zero. Stop on authorization, authentication, quota, rate limit, provider failure, page-loss equivalent input failure, or a model mismatch; never silently rerun a completed ordinal.

  Implement the helper contracts used above as follows:

  ```js
  function findModelRun(runs, model) {
    const matches = runs.filter((run) => run.modelIdentity.model === model);
    if (matches.length !== 1) throw modelAbError("MODEL_AB_RUN_SHAPE", `Expected one formal result for ${model}.`);
    return matches[0];
  }

  function assertDiagnosticAccepted(privateRoot) {
    const report = readCanonicalJson(path.join(privateRoot, "reports", "diagnostic.json"));
    if (report.status !== "diagnostic_pass" || report.accepted !== true) {
      throw modelAbError("MODEL_AB_DIAGNOSTIC_REQUIRED", "Formal execution requires an accepted diagnostic report.");
    }
  }

  function readAndVerifyManifest(privateRoot, sourcePrivateRoot, evaluatedCommit) {
    const manifest = readCanonicalJson(path.join(privateRoot, "run-manifest.json"));
    const source = loadConfirmedSourceInputs({ sourcePrivateRoot, paths: fixedSourcePaths(sourcePrivateRoot), assertResumeIdentityRedacted });
    if (manifest.evaluatedCommit !== evaluatedCommit || JSON.stringify(manifest.sourceIdentity) !== JSON.stringify(source.sourceIdentity)) {
      throw modelAbError("MODEL_AB_MANIFEST_MISMATCH", "The run manifest no longer matches the confirmed source inputs.");
    }
    return manifest;
  }

  function writePhaseReports(privateRoot, phase, value) {
    const report = assertSafeArtifact({ phase, accepted: value.assessment.accepted, status: value.assessment.status,
      failureReasons: value.assessment.failureReasons, runs: value.runs.map(sanitizeRun), manifestSha256: valueSha256(value.manifest) });
    exclusivePrivateWrite(privateRoot, path.join(privateRoot, "reports", `${phase}.json`), JSON.stringify(report, null, 2) + "\n");
    exclusivePrivateWrite(privateRoot, path.join(privateRoot, "reports", `${phase}.md`), renderModelAbMarkdown(report));
    return report;
  }

  function fixedSourcePaths(sourcePrivateRoot) {
    return {
      profile: path.join(sourcePrivateRoot, "input", "confirmed-profile.private.json"),
      matchingCard: path.join(sourcePrivateRoot, "input", "confirmed-card.private.json"),
      jobs: path.join(sourcePrivateRoot, "input", "jobs.private.json"),
      labels: path.join(sourcePrivateRoot, "labels", "jobs.reviewed.json")
    };
  }
  ```

  `sanitizeRun(run)` returns hashes, model identity, bounded aggregate telemetry, row counts and opaque IDs; it never returns a raw row object. `executeOneModelRun()` must calculate each row's `falseHardExclusion` from `expectedDisposition`, `expectedBucket` and `actualBucket`, attach `usage: { inputTokens, outputTokens }` only when complete, and reject an unexpected semantic cache hit.

- [ ] **Step 6: Add runtime smoke tests with an injected fake production pipeline**

  Use synthetic jobs and an injected fake analyzer/logger. Assert all of the following without a network call:

  ```js
  const result = await runner.runModelAbPhase(validDiagnosticRequest, {
    modules: syntheticProductionModules,
    resolveRuntimeModelConfig: () => verifiedDeepSeekConfig,
    inspectCleanHead: () => "1".repeat(40)
  });
  assert.strictEqual(result.status, "diagnostic_pass");
  assert.deepStrictEqual(observedModelOrder, ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.strictEqual(new Set(observedCachePaths).size, observedCachePaths.length);
  assert.strictEqual(settingsWriteAttempts, 0);
  assert.strictEqual(serializedArtifacts.includes("synthetic secret"), false);
  assert.strictEqual(serializedArtifacts.includes("synthetic JD text"), false);
  ```

  Also assert: a diagnostic structural failure blocks formal execution; formal cannot pass with 19 rows; any `cacheHitCount > 0` fails the run; source profile/card are consumed but never regenerated; Pro/Flash identities differ only in model after secret removal; every report passes `assertSafeArtifact`; and the existing model setting file bytes are unchanged before and after the run.

- [ ] **Step 7: Run focused runner tests and commit**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  node tests/private_full_chain_runner_smoke.js
  ```

  Expected: both commands exit 0.

  Commit:

  ```powershell
  git add scripts/model-ab-benchmark.js tests/model_ab_benchmark_smoke.js
  git commit -m "feat: run isolated DeepSeek model A/B benchmark"
  ```

### Task 4: Add the non-runnable casebook diagnostic and final report composition

**Files:**

- Modify: `scripts/model-ab-benchmark.js`
- Modify: `tests/model_ab_benchmark_smoke.js`
- Modify: `docs/recommendation_casebook.md`

**Interfaces:**

- Consumes: one private casebook snapshot identified by `REC-20260803-001-golang-ai-backend` and no candidate resume reconstruction.
- Produces: a sanitized status `{ caseId, status, failureCategory, failureSignature, observedRecommendation, expectedRecommendation, rerunnable }` in the A/B report.
- Permitted `status` values: `offline_only_missing_inputs`, `casebook_snapshot_invalid`, `runnable_but_not_executed`, or `not_found`.

- [ ] **Step 1: Write failing casebook-sanitization tests**

  Add synthetic casebook snapshot tests. The output must never contain job title, company, URL, JD description, analysis evidence, candidate evidence text, secret, endpoint or full model response.

  ```js
  const diagnostic = runner.diagnoseCasebookAvailability(syntheticCasebookRoot, "REC-20260803-001-golang-ai-backend");
  assert.deepStrictEqual(diagnostic, {
    caseId: "REC-20260803-001-golang-ai-backend",
    status: "offline_only_missing_inputs",
    failureCategory: "primary_delivery_language_misclassified",
    failureSignature: "title_language_required_but_missing_requirement_weighted_as_supporting",
    observedRecommendation: "apply",
    expectedRecommendation: "caution",
    rerunnable: false
  });
  assert.strictEqual(JSON.stringify(diagnostic).includes("synthetic private JD"), false);
  ```

- [ ] **Step 2: Run the focused test and confirm the missing diagnostic fails**

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code non-zero because `diagnoseCasebookAvailability` is not yet exported.

- [ ] **Step 3: Implement availability-only casebook diagnosis**

  Read the casebook snapshot only under the approved casebook root. Parse it defensively and return a safe summary. A live model call is allowed only if the snapshot itself contains independently validated frozen job, profile, card and redacted-resume references; otherwise report `offline_only_missing_inputs` and do not attempt to reconstruct any data from BOSS or history.

  ```js
  function diagnoseCasebookAvailability(casebookRoot, caseId) {
    const snapshot = readCasebookSnapshot(casebookRoot, caseId);
    if (!snapshot) return { caseId, status: "not_found", rerunnable: false };
    if (!isExpectedCasebookShape(snapshot)) return { caseId, status: "casebook_snapshot_invalid", rerunnable: false };
    const rerunnable = hasValidatedFrozenInputs(snapshot);
    return {
      caseId,
      status: rerunnable ? "runnable_but_not_executed" : "offline_only_missing_inputs",
      failureCategory: safeCaseEnum(snapshot.error?.category),
      failureSignature: safeCaseSignature(snapshot.error?.failureSignature),
      observedRecommendation: safeRecommendation(snapshot.observed?.recommendation),
      expectedRecommendation: safeRecommendation(snapshot.expected?.recommendation),
      rerunnable
    };
  }
  ```

  Do not change case status, do not add a production rule, and do not put the case into the 20-row denominator. Include its safe availability/status in the final A/B report only.

- [ ] **Step 4: Compose a final private report**

  Add `--report` to read immutable diagnostic/formal reports plus the safe casebook diagnostic and emit `reports/model-ab-final.json` and `reports/model-ab-final.md`. Use `renderModelAbMarkdown()` and include: final status, stage completion, coverage, retention, false hard exclusions, median/p95 latency, token/cost estimate label, disagreement counts, the 20-row precision limitation, and casebook availability. Do not include any row rationale or model response.

- [ ] **Step 5: Update the casebook guide and run tests**

  Append the following rule to `docs/recommendation_casebook.md`:

  ```markdown
  ## Use in model comparisons

  A casebook entry may be reported as an adversarial diagnostic in a private
  model comparison. It is not part of the formal benchmark denominator and may
  trigger a live re-evaluation only when it contains independently validated,
  frozen job/profile/card/redacted-resume inputs. Missing inputs require an
  offline-only status; never reconstruct them from BOSS, job history or a
  candidate resume.
  ```

  Run:

  ```powershell
  node tests/model_ab_benchmark_smoke.js
  ```

  Expected: exit code 0; every synthetic casebook result is sanitized.

- [ ] **Step 6: Commit casebook/report support**

  ```powershell
  git add scripts/model-ab-benchmark.js tests/model_ab_benchmark_smoke.js docs/recommendation_casebook.md
  git commit -m "feat: report model A/B casebook diagnostics"
  ```

### Task 5: Integrate offline tests and perform implementation verification

**Files:**

- Modify: `tests/run_all.js`
- Modify: `package.json`
- Modify: `tests/model_adapter_smoke.js` only if implementation needs provider cache-class token fields beyond generic input/output counts.

**Interfaces:**

- Consumes: the completed A/B runner and smoke test.
- Produces: a focused package command and full-suite coverage with no live model call.

- [ ] **Step 1: Register the focused test and package command**

  Add `model_ab_benchmark_smoke.js` immediately before `private_full_chain_runner_smoke.js` in `tests/run_all.js`. Add this package script without changing existing scripts:

  ```json
  "test:model-ab": "node tests/model_ab_benchmark_smoke.js"
  ```

- [ ] **Step 2: Add adapter coverage only if exact cache-class pricing is implemented**

  The default implementation uses generic completed-call input/output usage and cache-miss rates, so no adapter change is needed. If implementation elects to retain DeepSeek cache hit/miss counters, extend `normalizeUsage()` in `src/adapters/models/openai_compatible.js` with bounded numeric fields only, add matching assertions in `tests/model_adapter_smoke.js`, and update the A/B metrics to use them. Do not claim invoice-exact cost unless both cache classes are present for every completed call.

- [ ] **Step 3: Run focused offline verification**

  Run:

  ```powershell
  npm.cmd run test:model-ab
  node tests/private_full_chain_runner_smoke.js
  node tests/model_adapter_smoke.js
  ```

  Expected: each exits 0. No command may set a live-benchmark authorization variable or call the network.

- [ ] **Step 4: Run the full offline suite and inspect the diff**

  Run:

  ```powershell
  npm.cmd test
  git diff --check
  git status --short
  ```

  Expected: the test runner reports all checks passed; `git diff --check` emits no whitespace errors; `git status --short` contains only the files in this plan before staging.

- [ ] **Step 5: Commit integration after fresh verification**

  ```powershell
  git add tests/run_all.js package.json tests/model_adapter_smoke.js
  git commit -m "test: cover private model A/B benchmark"
  ```

  Omit `tests/model_adapter_smoke.js` from this commit if it was not changed.

### Task 6: Execute the approved live benchmark only after a fresh run confirmation

**Files:**

- No repository source changes.
- Create: a new private run directory such as `D:\DevData\RoleFlow-private-benchmark\model-ab-v4-pro-flash-YYYYMMDD-HHMMSS`.

**Interfaces:**

- Consumes: completed offline-verified runner, clean committed worktree, verified runtime model settings, frozen confirmed source bundle, and a user confirmation immediately before paid live calls.
- Produces: immutable private manifests, diagnostic/formal reports and a concise non-sensitive handoff.

- [ ] **Step 1: Obtain a fresh explicit confirmation immediately before live calls**

  State the exact workload and that default settings remain unchanged:

  ```text
  I am ready to make paid API calls: Stage 1 has 18 job evaluations (3 jobs × 3 repetitions × 2 models). If it passes, Stage 2 has 40 job evaluations (20 jobs × 2 models). Output stays under D:\DevData\RoleFlow-private-benchmark and the default model remains unchanged. Confirm to start this live run.
  ```

  Do not run any command in this task until the user gives that confirmation.

- [ ] **Step 2: Verify clean state and initialize a new immutable private bundle**

  After confirmation, choose a timestamped target below the approved private parent and use the established confirmed source bundle. Set only authorization variables for the current PowerShell process.

  ```powershell
  $runStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $runRoot = "D:\DevData\RoleFlow-private-benchmark\model-ab-v4-pro-flash-$runStamp"
  $sourceRoot = "D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730"
  $pricingObservedAt = (Get-Date).ToUniversalTime().ToString("o")
  $env:ALLOW_PRIVATE_MODEL_AB_BENCHMARK = "YES"
  $env:ALLOW_PRIVATE_RESUME_BENCHMARK = "YES"
  $env:ALLOW_LIVE_MODEL_BENCHMARK = "YES"
  git status --short
  node scripts/model-ab-benchmark.js --init --private-root $runRoot --source-private-root $sourceRoot --model-settings-root "D:\Guo\ZhiPing" --pricing-observed-at $pricingObservedAt
  ```

  Expected: empty Git status before the run and a new private `run-manifest.json`. Do not print the manifest if it contains a private path; inspect only its safe status/hash fields.

- [ ] **Step 3: Run Stage 1 serially and inspect its gate report**

  ```powershell
  node scripts/model-ab-benchmark.js --live --phase diagnostic --private-root $runRoot --source-private-root $sourceRoot --model-settings-root "D:\Guo\ZhiPing"
  node scripts/model-ab-benchmark.js --casebook-diagnose --private-root $runRoot --casebook-root "D:\DevData\RoleFlow-private-benchmark\recommendation-casebook" --case-id "REC-20260803-001-golang-ai-backend"
  ```

  Expected: a sanitized diagnostic report with six runs/18 evaluations. If any structural/quality gate fails, stop; do not invoke formal phase, do not alter model settings, and report `diagnostic_pass: false` with safe counts only.

- [ ] **Step 4: Run formal phase only after Stage 1 passes**

  ```powershell
  node scripts/model-ab-benchmark.js --live --phase formal --private-root $runRoot --source-private-root $sourceRoot --model-settings-root "D:\Guo\ZhiPing"
  node scripts/model-ab-benchmark.js --report --private-root $runRoot
  ```

  Expected: 20 usable rows per model, a formal acceptance status, and a conservative cache-miss cost estimate based on completed-call token telemetry. Any incomplete coverage, quality regression, insufficient speed gain or missing cost telemetry is a non-eligible result, not a silent fallback.

- [ ] **Step 5: Deliver results and preserve the decision boundary**

  Report only the final status and safe aggregates: quality gates, coverage, latency, token/cost estimate, recommendation-disagreement count, 20-row exclusion-coverage limitation and Golang casebook availability. Explicitly ask the user before changing the saved model setting, even if the final status is `flash_eligible`.
