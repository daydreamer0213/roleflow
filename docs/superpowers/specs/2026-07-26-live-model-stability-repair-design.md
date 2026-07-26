# Live model stability repair design

## Status

The private full-chain v3 comparison completed with `accepted=false`. The user approved continuing with a focused repair round. This design does not authorize BOSS access, communication actions, main-database access, port 8787, or a merge into the active product.

## Observed problem

The candidate completed only 12 of 20 job analyses. The eight failures comprised three timeouts, one final contract failure, and four errors collapsed into `MODEL_ANALYSIS_FAILED`. Cache identity proves that four failures occurred during `understandJob` and four after a successful understanding while entering `matchJob`.

Most of the increased hard-false-placement count came from failed analyses falling into `analysis_pending`; only one completed semantic result missed a required hard exclusion. The current contract validates `indispensable_core blocker -> missing indispensable requirement`, but not the reverse direction.

## Chosen approach

Use a minimal diagnostic-and-contract repair before changing matching semantics:

1. Preserve safe model failure classes instead of collapsing them:
   - `MODEL_INVALID_JSON`
   - `MODEL_OUTPUT_TRUNCATED`
   - `MODEL_INVALID_RESPONSE`
   - existing timeout, request, and contract codes
2. Detect `finish_reason=length` and malformed OpenAI-compatible response envelopes without logging response content.
3. Propagate a safe `modelStage` (`understandJob` or `matchJob`) and phase (`initial` or `contract_repair`) into failed analyses and the private benchmark row.
4. Require every `state=missing && indispensable=true` requirement to have one complete, same-name `indispensable_core` blocker. This triggers the existing single repair request rather than restoring occupation-specific local blockers.
5. Add explicit evidence and array length limits to prompts. Do not remove JD coverage, candidate evidence, the five states, or dual-evidence rules.
6. Reduce default semantic-analysis concurrency and the private acceptance harness to one. This trades throughput for completion reliability and follows the product rule that quality takes priority over speed.

## Rejected approaches

### Restore local technology or role keyword blockers

Rejected because the candidate correctly removed two false hard exclusions. Reintroducing broad local blockers would fix one sample by recreating known occupation-specific errors.

### Treat failed analyses as ordinary `review/talk`

Rejected because it would hide model reliability failures. `analysis_pending` remains the safe operational state and acceptance continues to require `failed=0`.

### Blindly increase timeout or repeatedly rerun until metrics pass

Rejected because it would not identify invalid JSON, truncated output, or contract failures and could turn provider variance into a false success.

## Privacy-safe diagnostics

Diagnostics may record only:

- stage and phase
- stable error code
- attempt count
- HTTP status
- whether JSON mode was used
- provider request ID hash
- finish reason
- response-content character count and SHA-256
- output top-level shape

They must not record prompts, response content, resume text, JD text, company names, job URLs, contact details, API keys, or endpoint contents.

## Acceptance

Offline acceptance requires targeted adapter, contract, semantic-pipeline, private-runner, and full-suite tests to pass with a clean worktree.

The next private live comparison must:

- reuse the same confirmed profile, confirmed matching card, 20 frozen jobs, and labels;
- use a new private harness version and fresh baseline/candidate caches;
- run baseline and candidate serially under the same model identity;
- keep `failed/stale/pending=0`;
- avoid accuracy and hard-placement regressions;
- remain `accepted=false` and unmerged if any gate fails.
