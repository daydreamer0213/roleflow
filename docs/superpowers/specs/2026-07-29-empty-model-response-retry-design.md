# Empty Model Response Retry Design

## Problem

Two fresh private diagnostics reached the model adapter but ended during
`understandJob` with the same safe signature:

- HTTP 200;
- empty response envelope and zero response characters;
- `MODEL_INVALID_RESPONSE`;
- no contract repair and no completed semantic stage;
- roughly 172–176 seconds total.

The upstream empty body is the trigger. RoleFlow then amplifies it because
`MODEL_INVALID_RESPONSE` currently shares the token-expansion and JSON-mode
fallback path used for truncation and malformed structured output.

## Decision

Treat an HTTP-success response whose complete body is only whitespace as a
separate transport failure:

```js
{
  code: "MODEL_EMPTY_RESPONSE",
  retryable: true,
  responseFailureKind: "empty_response",
  responseEnvelopeKind: "empty",
  contentLength: 0
}
```

With `maxRetries: 1`, retry it once using exactly the same `max_tokens` and JSON
mode. `MODEL_EMPTY_RESPONSE` must not:

- increase the token budget;
- disable JSON mode;
- enter model-contract repair;
- change handling for non-empty invalid JSON, truncated output, HTTP errors or
  valid responses.

## Safe attempt telemetry

The adapter emits one safe attempt event after every HTTP attempt:

- `model_call_attempt_completed`; or
- `model_call_attempt_failed`.

The payload is limited to stage, ordinal attempt number, attempt latency,
HTTP/error classification, response length, JSON-mode flag and requested token
limit. It contains no prompt, response body, JD, resume evidence, provider
request ID, endpoint, API key or model identity.

The private runner persists only bounded aggregates per logical row:

- `modelAttemptCount`;
- `emptyResponseAttemptCount`;
- `modelAttemptLatencyMs`.

Existing `modelCallCount` keeps its meaning: completed semantic stages, not HTTP
attempts.

## Alternatives rejected

1. Increase the timeout: this hides the classification error and increases
   worst-case latency.
2. Add streaming/SSE parsing now: useful only if non-streaming reliability
   remains poor after the bounded retry fix; it is a larger transport rewrite.
3. Switch provider automatically: changes model comparability and requires a
   separate product decision.

## Verification

- Adapter regression proves two empty bodies produce exactly two identical
  requests and final `MODEL_EMPTY_RESPONSE`.
- Adapter regression proves one empty response followed by valid JSON succeeds
  without token expansion or JSON-mode fallback.
- Existing malformed/truncated response tests retain their current three-request
  behavior.
- Private runner regression proves the new aggregates are bounded, reset per row,
  excluded from benchmark decisions and cannot leak event payloads.
- The complete offline suite must pass before commit.

No live model or recruitment-platform call is part of this change.
