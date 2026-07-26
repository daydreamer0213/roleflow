# Live model stability v4-r4 diagnostic preflight

Candidate product commit: `b73059901133084aa873f624d7e9de592a53a528`

Harness: `private-full-chain-harness.v2`

The bounded diagnostic mode validates the complete frozen 20-row fixture and confirmed provenance chain before selecting one to five explicit indices. Diagnostic results record `acceptanceEligible=false`; the formal comparator additionally requires empty diagnostic indices and a complete row count equal to the frozen total.

The first five-row probe exceeded its ten-minute outer limit and was stopped after exact process-identity verification. A fresh two-row probe completed in about nine minutes. One former contract-repair failure completed. The other row moved past its former `understandJob` failure but ended during initial `matchJob` with `MODEL_INVALID_RESPONSE`, `invalid_response_json`, and an 8192-token request. No formal comparison or full run was started.

The new diagnostic telemetry records only whether the failing request applied JSON mode and an integer HTTP status from 100 through 599. Unknown values become `null`. Response bodies, headers, endpoint, prompts, model settings, job content, resume content, and provider error text are not persisted.

Offline verification: the adapter red-to-green regression proved that a final failed request without `response_format` records `jsonModeApplied=false`; adapter, semantic-pipeline, and private-runner smoke tests passed; `npm.cmd test` passed all 47 offline checks; `git diff --check` passed; independent read-only review approved the telemetry and privacy boundary.

The next live action is a fresh one-row candidate diagnostic for the single remaining failed position. It is not acceptance evidence and its cache must not be reused in a full run.
