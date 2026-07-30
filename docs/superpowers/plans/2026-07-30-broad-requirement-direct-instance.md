# Broad requirement direct-instance implementation plan

## Goal

Remove the false caution caused by classifying a concrete direct instance of a
broad requirement as merely transferable, without weakening true transfer
boundaries.

## Files

- Modify `tests/model_adapter_smoke.js`.
- Modify `tests/semantic_pipeline_smoke.js`.
- Modify `src/adapters/models/openai_compatible.js`.
- Modify `src/core/analysis_revision.js`.
- Update the two authoritative private benchmark plans after review.

## Steps

1. Add failing adapter prompt assertions for both halves of the generic rule:
   a narrower concrete instance of a broad, unqualified capability is
   `matched`; an explicitly named but unproved domain/platform/tool/specialist
   difference remains `transferable`.
2. Add semantic assertions that the current match pipeline is v30 and a v29
   revision becomes `match_pipeline_changed`.
3. Run model-adapter and semantic smoke tests and confirm RED.
4. Add one compact general instruction to the existing match prompt. Do not
   add any private or technology-specific example.
5. Increment `PIPELINE_VERSIONS.matchJob` from v29 to v30.
6. Run focused tests, commit the product fix, then run model adapter, semantic
   pipeline, generic evidence matching, all 31 benchmark fixtures, all offline
   checks, and diff check from a clean commit.
7. Obtain independent review when an independent reviewer is available. A
   reviewer quota failure must be recorded; it must not be misreported as an
   approval.
8. Create and exactly bind a docs-only evaluated descendant.
9. Preserve validation-idempotence v1 and all older roots. Require
   `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`
   to be absent, then rebuild seven frozen files, manifest, v3 proof, verifier
   outputs, and a fresh cache.
10. Run exact zero-based indices `4,9,10`, restore the fixed candidate in
    `finally`, and keep the 20-row root absent unless all three rows pass.

## Non-goals

- No local transferable promotion.
- No private benchmark hard-coding.
- No validator relaxation.
- No extra model repair or thinking-policy change.
- No BOSS access.
