# DeepSeek Job Understanding Non-Thinking Design

## Problem

The current official DeepSeek V4 Pro configuration has a 60-second per-attempt
timeout. One frozen real JD produced the following evidence:

- the ordinary candidate flow made two 60-second attempts and ended with
  `MODEL_TIMEOUT`;
- 1,024 output tokens finished in 15.7 seconds but were truncated;
- 2,048 output tokens finished in 34.5 seconds but were truncated;
- one 4,096-token attempt with a 90-second timeout finished in 73.7 seconds but
  was still truncated;
- a minimal request completed in 1.09 seconds;
- the same full `understandJob` prompt with DeepSeek thinking disabled returned
  HTTP 200 in about 13.8 seconds and passed the `understandJob` model contract.

DeepSeek V4 enables thinking mode by default. Increasing the timeout therefore
waits longer for reasoning that consumes the output budget; it does not produce
a complete structured result for this sample.

## Decision

For `understandJob` only, add:

```json
{"thinking":{"type":"disabled"}}
```

when both conditions are true:

1. the configured model is `deepseek-v4-pro` or `deepseek-v4-flash`; and
2. the configured endpoint host is exactly `api.deepseek.com`.

Keep all other behavior unchanged:

- the timeout remains 60 seconds;
- `matchJob`, resume analysis, matching-card generation and communication
  drafting retain their current model mode;
- non-DeepSeek and custom OpenAI-compatible endpoints receive no `thinking`
  field;
- token limits, retry rules, JSON mode and model-contract repair stay unchanged;
- model settings and the private benchmark model-identity fingerprint do not
  change.

## Why This Scope

`understandJob` is structured fact extraction from one JD. Its output is
constrained by direct evidence, bounded arrays and strict contract validation,
so high-effort hidden reasoning has low expected value. Disabling thinking for
`matchJob` would have a larger possible accuracy trade-off because that stage
compares the JD against candidate evidence; it remains unchanged until measured
separately.

Endpoint and model checks prevent an OpenAI-compatible service that does not
implement DeepSeek's extension from receiving an unknown request field.

## Alternatives Rejected

1. Raise the global timeout to 90 seconds. The real 4,096-token request still
   truncated after 73.7 seconds, and retaining retries would increase the
   worst-case delay.
2. Disable thinking for every model call. This has a wider unmeasured quality
   effect, especially on candidate-to-JD matching.
3. Reduce `max_tokens`. Both 1,024 and 2,048 truncated the same real JD.
4. Add a user-facing thinking-mode setting now. The current requirement is one
   verified provider/stage behavior; a new setting and migration would be
   unnecessary product surface.

## Tests

The adapter smoke test must prove the actual outgoing request body:

- official DeepSeek V4 `understandJob` includes
  `thinking: {type: "disabled"}`;
- official DeepSeek V4 `matchJob` does not include `thinking`;
- another model on the official endpoint does not include `thinking`;
- DeepSeek V4 on a custom endpoint does not include `thinking`.

All existing malformed-response, empty-response and retry tests must retain
their behavior.

After offline tests pass, create a fresh cache-empty private diagnostic bundle
and run exactly frozen job index 0 through the complete candidate flow. Report
the two stage timings, attempts, contract repairs, final role alignment and
bucket. Do not start a 20-row run in this change.

## Safety and Quality Gate

- No BOSS or browser access is required.
- Formal model settings may be read only through the existing authorized
  `--model-settings-root` path.
- No response body, prompt, resume text or JD text may be added to telemetry or
  Git.
- The change is not accepted on speed alone: the one-row result must complete
  both semantic stages without contract repair and preserve evidence-bearing
  output for user review.
