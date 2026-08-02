# Deterministic Split Semantic Matching v4.7 Implementation Plan

**Date:** 2026-08-02

## Task 1: Freeze the experiment conclusion

- [x] Preserve the failed v1 split root.
- [x] Run the corrected v2 split experiment with fresh calls.
- [x] Confirm 27/27 calls, 9/9 structural pass, 9/9 behavior pass, zero misses,
  and zero false default selections.
- [x] Confirm identical `understandJob` inputs still produce varying outputs.
- [x] Compare the selected design with official provider engineering guidance.

## Task 2: Add failing split-pipeline tests

- [ ] Extend `tests/model_adapter_smoke.js` with a `semanticMatchingMode=split`
  case requiring exactly two narrow calls.
- [ ] Assert local evidence truncation, omitted-row normalization, canonical
  role alignment, and no shadow model recommendation.
- [ ] Extend `tests/semantic_pipeline_smoke.js` to require the job runner to
  pass `semanticMatchingMode=split` and `modelRecommendationMode=off`.
- [ ] Run the two focused tests and confirm the new assertions fail for the
  intended missing behavior.

## Task 3: Implement deterministic split matching

- [ ] Add `src/core/split_semantic_matching.js` with pure exact-key, ID, state,
  evidence, omission, role-alignment, and combination helpers.
- [ ] Add the OpenAI-compatible split branch and two task-specific prompts.
- [ ] Keep the existing combined branch under `semanticMatchingMode=legacy`.
- [ ] Add `matchResponsibilities` and `matchRequirements` to deterministic
  DeepSeek non-thinking call kinds.
- [ ] Default the job runner to split mode and force the split branch's model
  recommendation mode off.
- [ ] Increment `PIPELINE_VERSIONS.matchJob` to `match-decision-v42`.
- [ ] Make the focused tests pass.

## Task 4: Run offline regression

- [ ] Run `node tests/semantic_pipeline_smoke.js`.
- [ ] Run `node tests/model_adapter_smoke.js`.
- [ ] Run the 31-fixture job benchmark.
- [ ] Run the private runner smoke test.
- [ ] Run `npm.cmd test`.
- [ ] Run `git diff --check`.

## Task 5: Independent review and product checkpoint

- [ ] Request a read-only spec review.
- [ ] Request a read-only code-quality review.
- [ ] Fix Important/Critical findings with a failing regression first.
- [ ] Repeat review until Spec PASS and Code quality APPROVED.
- [ ] Commit the product checkpoint.
- [ ] Push `codex/multi-track-recall-continuation`.

## Task 6: Synchronize evaluated artifacts

- [ ] Update the private manifest to the new candidate evaluated commit and
  shared file blobs without exposing private input.
- [ ] Recompute profile/card envelopes with the existing private helper.
- [ ] Confirm product commit ancestry and baseline binding.
- [ ] Preserve every previous live root.

## Task 7: Fresh three-row live acceptance

- [ ] Create a new immutable v4.7 three-row root with a fresh cache.
- [ ] Use the established diagnostic indices without index conversion.
- [ ] Verify structure, safety gates, expected selection recall, and false
  default selection count.
- [ ] Publish a concrete beginner-friendly Chinese stage report.
- [ ] Stop before 20 rows if any expected selected row is missed or any
  expected non-selected row enters default communication.

## Task 8: Fresh 20-row live acceptance

- [ ] Create a new immutable v4.7 20-row root with a completely fresh cache.
- [ ] Do not reuse the three-row cache.
- [ ] Require all expected `primary`/`apply` rows to be selected.
- [ ] Require zero expected `caution`/`not_recommended` rows in default
  communication.
- [ ] Report all exact-tier deviations as diagnostics.
- [ ] Publish the required Chinese stage report.

## Task 9: Final regression, review, and push

- [ ] Restore the live worktree to its original branch and clean state.
- [ ] Re-run the required offline regression.
- [ ] Update design, plan, and evaluated-checkpoint records.
- [ ] Complete final read-only review.
- [ ] Commit and push all accepted checkpoints to GitHub.
- [ ] Do not merge or modify `main`.

