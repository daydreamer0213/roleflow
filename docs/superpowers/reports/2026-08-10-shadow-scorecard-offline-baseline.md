# Shadow Scorecard Offline Baseline

## Scope

This baseline uses two synthetic, redacted cases created only for the Wave 1.2
feasibility check. It contains no live database rows, private resume/JD data,
credentials, browser state, model output, or BOSS identifiers.

## Fixture outcomes

| Case | Existing final tier | Candidate tier | Expected diagnostic |
|---|---|---|---|
| `synthetic-hard-boundary` | `not_recommended` | `not_recommended` | verified hard boundary remains a block despite positive fit |
| `synthetic-strong` | `primary` | `primary` | approved weighted matrix reproduces a strong aligned case |

The report summary is:

```json
{
  "inputUnchanged": true,
  "total": 2,
  "candidateTierCounts": {
    "primary": 1,
    "apply": 0,
    "caution": 0,
    "not_recommended": 1
  },
  "changedCandidateTierCount": 0
}
```

## Commands and observed results

```powershell
node tests/shadow_scorecard_smoke.js
# shadow_scorecard_smoke ok

node tests/four_tier_decision_smoke.js
node tests/four_tier_pipeline_smoke.js
node tests/four_tier_product_surface_smoke.js
node tests/four_tier_benchmark_metrics_smoke.js
# all four commands exit 0

git diff --check
# exit 0
```

An additional established offline focus set of 16 tests, including the new
scorecard smoke and the existing four-tier, browser-contract, access-budget,
matching-card, and source-acquisition checks, exited 0.

The full suite was attempted with `npm.cmd test` but stopped in the existing
`tests/self_check.js` PDF fixture check because the current worktree has no
`node_modules/pdfjs-dist`. The same failure reproduces with
`node tests/self_check.js` and `node tests/resume_parser_pdf_order_smoke.js`;
the dependency is present only in separate D: runtime worktrees, and
`NODE_PATH` does not satisfy the ESM import. No dependency was installed and no
unrelated production file was changed.

The explicit CLI invocation used a temporary synthetic fixture and output
path. It exited 0 and verified the input SHA-256 was unchanged. The CLI did
not receive a database path and has no code path for model, network, browser,
or directory scanning.

## Interpretation

This baseline demonstrates feasibility of deterministic offline replay and
guard ordering. It does not establish recommendation quality, recall,
precision, latency, or production value. Semantic instability and deterministic
policy sensitivity remain separate measurements: the former requires replaying
different semantic outputs, while the latter requires replaying the same
fixture with an explicitly versioned policy.

## Later production-shadow suitability

The idea is suitable for a later *read-only* production shadow integration in
principle, but not approved for integration by this Wave 1.2 task. Before any
integration, the controller should approve privacy-safe fixture boundaries,
measure latency and storage cost, confirm that formal outputs remain byte-for-
byte unchanged, and demonstrate diagnostic value on a fresh offline baseline.
