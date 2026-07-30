# Cross-track responsibility-sprawl boundary implementation plan

## Goal

Prevent duties from separate explicit hiring tracks from being merged into a
single responsibility-sprawl concern while retaining real within-track sprawl.

## Files

- Modify `tests/model_adapter_smoke.js`.
- Modify `tests/semantic_pipeline_smoke.js`.
- Modify `src/adapters/models/openai_compatible.js`.
- Modify `src/core/analysis_revision.js`.
- Update the two authoritative benchmark plans.

## Steps

1. Add a failing `understandJob` prompt assertion that sprawl is evaluated
   within each independent track and duties across independent tracks are not
   combined.
2. Preserve the existing prompt assertion and synthetic fixture for real
   single-track sprawl.
3. Assert current versions are `job-understanding-v16` and
   `match-decision-v31`; assert v15/v30 revisions become stale.
4. Run model-adapter and semantic smoke tests and confirm RED.
5. Add one compact generic prompt sentence; do not add private examples.
6. Increment understanding v15 to v16 and match v30 to v31.
7. Run focused tests, commit, then run adapter, semantic, generic fixtures, 31
   benchmark fixtures, all offline checks, and diff check.
8. Attempt independent review. If reviewer quota remains exhausted, record
   that no approval was obtained.
9. Create and exactly bind a docs-only evaluated descendant.
10. Preserve direct-instance v1 and all prior roots. Require
    `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-track-sprawl-v1-20260730`
    to be absent, rebuild seven files/manifest/v3 proof/verifier/fresh cache,
    run zero-based `4,9,10`, and restore the fixed candidate in `finally`.
11. Do not create the 20-row root unless all three rows pass exact, structural,
    recall, and safety gates.

## Non-goals

- No suppression of genuine within-track sprawl.
- No local risk-signal override.
- No private hard-coding.
- No extra model call or thinking change.
- No BOSS access.
