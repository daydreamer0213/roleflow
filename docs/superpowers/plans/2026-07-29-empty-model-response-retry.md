# Empty Model Response Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle HTTP-success empty model bodies as one bounded transport retry without token expansion or JSON-mode fallback, while recording privacy-safe attempt aggregates.

**Architecture:** Classify the empty body at the adapter response boundary, before JSON parsing. Reuse the existing retry loop but keep the new error outside the expansion and JSON-recovery sets. Emit safe per-attempt events and let the private runner project them into three bounded numeric fields.

**Tech Stack:** Node.js 22 CommonJS, built-in `fetch`, `node:assert`, repository smoke-test scripts.

## Global Constraints

- No prompt, matching rule, model contract or normal structured-output behavior changes.
- No new dependency.
- No live model, browser, recruitment platform, main database or port 8787 access.
- Private telemetry must never persist prompt, response body, JD/resume/card content, endpoint, key, provider request ID or model identity.
- Follow red-green TDD for each task.

---

### Task 1: Classify and bound empty-response retries

**Files:**

- Modify: `src/adapters/models/openai_compatible.js`
- Test: `tests/model_adapter_smoke.js`

**Interfaces:**

- Produces error code `MODEL_EMPTY_RESPONSE`.
- Produces failure kind `empty_response`.
- Emits `model_call_attempt_completed` and `model_call_attempt_failed` with safe
  metadata.

- [ ] **Step 1: Add failing adapter regressions**

Extend the fake HTTP server with two scenarios:

```js
if (scenario === "empty-response-final") {
  res.end("");
  return;
}
if (scenario === "empty-response-then-valid") {
  if (scenarioAttempt === 1) res.end("");
  else res.end(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
  }));
  return;
}
```

Assert the final-empty case:

```js
assert.strictEqual(error.code, "MODEL_EMPTY_RESPONSE");
assert.strictEqual(error.responseFailureKind, "empty_response");
assert.strictEqual(error.responseEnvelopeKind, "empty");
assert.strictEqual(error.contentLength, 0);
assert.deepStrictEqual(emptyPayloads, [
  { maxTokens: 4096, jsonMode: true },
  { maxTokens: 4096, jsonMode: true }
]);
```

Assert the recoverable case returns `{ ok: true }` with the same two request
descriptors. Assert two safe attempt events exist and serialized event data does
not contain the response sentinel or any prompt/body key.

- [ ] **Step 2: Run the red test**

```powershell
node tests/model_adapter_smoke.js
```

Expected: fail because empty bodies are still `MODEL_INVALID_RESPONSE` and the
second request expands to 8192 tokens.

- [ ] **Step 3: Implement the minimal adapter branch**

Before `JSON.parse(rawEnvelope)`:

```js
if (!String(rawEnvelope || "").trim()) {
  throw modelResponseError("MODEL_EMPTY_RESPONSE", "Model response body was empty.", {
    httpStatus: res.status,
    retryable: true,
    responseFailureKind: "empty_response",
    responseContentTypeKind,
    responseEnvelopeKind: "empty",
    responseParseFailureKind: "",
    responseHadUtf8Bom: false,
    contentLength: 0,
    jsonModeApplied: Boolean(jsonMode),
    requestedMaxTokens: maxTokens
  });
}
```

Add `empty_response` to the adapter safe failure-kind set. Do not add
`MODEL_EMPTY_RESPONSE` to `EXPANDABLE_RESPONSE_ERRORS` or
`JSON_MODE_RECOVERY_ERRORS`.

Wrap each `requestJson` attempt with an attempt start timestamp and emit the two
safe attempt event names. The event payload may contain only:

```js
{
  kind,
  attempt,
  latencyMs,
  httpStatus,
  errorCode,
  responseFailureKind,
  responseContentLength,
  jsonModeApplied,
  requestedMaxTokens
}
```

- [ ] **Step 4: Run focused green tests**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
git diff --check
```

Expected: all exit 0; existing invalid/truncated request sequences remain
unchanged.

- [ ] **Step 5: Commit the product fix**

```powershell
git add -- src/adapters/models/openai_compatible.js tests/model_adapter_smoke.js
git commit -m "fix: bound empty model response retries"
```

Record this commit as the candidate product commit for the next live diagnostic.

---

### Task 2: Persist bounded private attempt aggregates

**Files:**

- Modify: `scripts/private-full-chain-runner.js`
- Test: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**

- Consumes adapter attempt event names from Task 1.
- Produces row fields `modelAttemptCount`, `emptyResponseAttemptCount` and
  `modelAttemptLatencyMs`.

- [ ] **Step 1: Add failing private telemetry assertions**

Update the synthetic telemetry seam to emit safe successful and failed attempt
events. Add the three fields to the exact row schema and assert:

```js
{
  modelAttemptCount: 3,
  emptyResponseAttemptCount: 1,
  modelAttemptLatencyMs: 37500
}
```

Also assert invalid numbers and unknown event names contribute zero, the fields
reset per row, an injected extra field still fails the exact schema, serialized
rows contain none of the synthetic private sentinel, and benchmark metrics are
unchanged when the three fields are removed.

- [ ] **Step 2: Run the red test**

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: fail because the three aggregate fields do not exist.

- [ ] **Step 3: Extend the existing collector**

Initialize the three bounded integers to zero in
`createPrivateTelemetryCollector()`. For the two exact attempt event names,
require a safe stage and then:

```js
values.modelAttemptCount += 1;
values.modelAttemptLatencyMs += safeTelemetryInteger(data?.latencyMs);
if (event === "model_call_attempt_failed"
    && data?.errorCode === "MODEL_EMPTY_RESPONSE") {
  values.emptyResponseAttemptCount += 1;
}
```

Clamp every aggregate to `MAX_SAFE_TELEMETRY_INTEGER`. Add
`MODEL_EMPTY_RESPONSE` and `empty_response` to the runner allowlists.

- [ ] **Step 4: Run focused green tests**

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/model_adapter_smoke.js
git diff --check
```

Expected: all exit 0 and the private exact-schema/privacy checks pass.

- [ ] **Step 5: Commit the tooling telemetry**

```powershell
git add -- scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "test: record bounded model attempt telemetry"
```

---

### Task 3: Complete offline verification

**Files:**

- No source changes expected.

- [ ] **Step 1: Run targeted regression checks**

```powershell
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
node tests/private_full_chain_runner_smoke.js
node tests/job_match_benchmark.js
node tests/self_check.js
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete suite and Git checks**

```powershell
$env:NODE_NO_WARNINGS='1'
npm.cmd test
git diff --check
git status --short
```

Expected: all 47 registered offline checks pass; diff check and short status are
empty.

- [ ] **Step 3: Prepare a matching harness-only baseline**

Create a new baseline worktree from
`fb0168afce265cf351f03e80f66d9e0f24015887`, copy only:

```text
scripts/private-full-chain-runner.js
scripts/lib/benchmark_metrics.js
scripts/lib/private_resume_privacy.js
```

Commit once, then verify its single parent is the approved baseline product
commit and all three blobs equal the candidate evaluated HEAD. Do not run a live
model.
