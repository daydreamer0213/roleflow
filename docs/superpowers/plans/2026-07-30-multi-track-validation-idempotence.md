# Multi-track match validation idempotence implementation plan

## Goal

Make a validated multi-track sparse match result safe to validate repeatedly
without weakening the strict contract or changing model-call behavior.

## Files

- Modify `tests/semantic_pipeline_smoke.js`.
- Modify `src/core/model_contract.js`.
- Modify `src/core/analysis_revision.js`.
- Update the two authoritative private benchmark plans after review.

## Steps

1. Add a focused semantic-pipeline regression that builds a legal multi-track
   `jobUnderstanding` and legal sparse result containing one unrecognized key
   whose value is a synthetic privacy sentinel.
2. Validate the sparse result once, assert its local decision, then validate
   that normalized result again and assert deep equality.
3. Assert the normalized result retains only normalized sparse
   `matches`/`eligibility` rows needed for revalidation; the extra key and
   sentinel must not survive.
4. JSON serialize/parse the normalized result, validate the round-tripped
   value, and assert deep equality to cover persisted-cache shape.
5. Repeat the idempotence check for one single-track sparse result and assert
   an existing legacy single-track full decision remains valid.
6. Exercise a raw multi-track sparse result through an injected adapter and
   `createLlmAnalyzer`; assert the wrapper returns the same normalized,
   revalidatable decision without preserving the sentinel.
7. Assert a legacy multi-track full decision still throws
   `MODEL_CONTRACT_INVALID`.
8. Assert `PIPELINE_VERSIONS.matchJob === "match-decision-v29"` and pass a
   revision containing `match-decision-v28` to `analysisStaleReasons`; it must
   include `match_pipeline_changed`.
9. Run `node tests/semantic_pipeline_smoke.js`; it must fail before the product
   change because the second validation routes to the forbidden full-decision
   path and the pipeline version is still v28.
10. In `validateSparseMatchEvidence`, include only the already validated
   `matches`
   and `eligibility` arrays in the normalized return value.
11. Increment `PIPELINE_VERSIONS.matchJob` from `match-decision-v28` to
   `match-decision-v29`.
12. Run the focused test, then commit the new product fix.
13. From the clean product commit run `model_adapter_smoke`,
   `semantic_pipeline_smoke`, `job_match_benchmark`, all offline checks, and
   `git diff --check`.
14. Obtain independent review with no Critical, Important, or Moderate
    findings and explicit `Spec PASS` / `Code quality APPROVED`.
15. Create a docs-only evaluated descendant, record its exact SHA in a second
    docs-only binding record, and verify candidate/baseline strict ancestry,
    clean HEADs, and all three shared blobs.
16. Preserve sparse-repair roots v1 and v2. Require the new three-row root
    `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`
    to be absent before rebuilding seven frozen files, manifest, v3 proof,
    verifier outputs, and a fresh cache.
17. Run exact zero-based indices `4,9,10`; restore the fixed candidate in
    `finally`. Do not create the 20-row root unless all three rows are exact,
    structurally complete, and pass every safety gate.

## Non-goals

- No validation bypass.
- No legacy-decision conversion.
- No extra repair.
- No thinking-policy change.
- No BOSS access or private-output logging.
