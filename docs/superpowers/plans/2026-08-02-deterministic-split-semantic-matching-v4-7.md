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


## 2026-08-02 v4.7 reviewed product checkpoint

- Product checkpoint: `6faba4f038e9ff55ec5c0a94849dfff7091834d8` (`feat: add deterministic split semantic matching`).
- The model is limited to two narrow semantic extraction stages; local code validates exact shapes, derives role alignment, and applies the existing four-tier decision policy.
- The user-confirmed direction/requirement matrix and the existing 70/30 central/non-central weighting remain unchanged.
- Fresh offline evidence: `npm.cmd test` passed all 50 checks; `git diff --check` exited 0.
- Independent final review: `Spec PASS` and `Code quality APPROVED`; no Critical or Important behavior defect remained.
- The new production module `src/core/split_semantic_matching.js` is included in the product commit.
- Live acceptance must use fresh roots and fresh caches: first the frozen 3-job diagnostic sample, then the frozen 20-job pool only if the 3-job gate passes.
- Product acceptance target: no expected `primary`/`apply` job may be omitted from default communication, and no expected `caution`/`not_recommended` job may enter default communication.
- Private inputs, model configuration, and live outputs remain outside the repository. BOSS, cookies, `jobs.sqlite`, and port 8787 remain out of scope.
## v4.7.1 selective responsibility confirmation checkpoint

- [x] Preserve the failed fresh live root `deterministic-split-v4-7-first-3-20260802`.
- [x] Trace index 5 from the live bucket through local matrix metrics and compare it with all isolated repetitions.
- [x] Confirm that no matrix, weight, or threshold defect caused the deviation.
- [x] Choose conditional negative confirmation instead of prompt growth or matrix tuning.
- [ ] Add a failing adapter regression for conditional confirmation and recall-first reconciliation.
- [ ] Add the local reconciliation helper and conditional second responsibility call.
- [ ] Bump the match cache version and update version assertions.
- [ ] Run focused adapter/pipeline tests, the complete offline suite, and `git diff --check`.
- [ ] Obtain independent `Spec PASS` and `Code quality APPROVED`.
- [ ] Commit and push product and evaluated checkpoints.
- [ ] Create a new private root and rerun diagnostic indices `5,8,13` with a fresh cache.
- [ ] Run the frozen 20-job pool only if both expected default-communication jobs are retained and the expected caution job remains unselected.
### v4.7.1 review clarifications

- [x] Lock the confirmation input and output to the first validated selected track.
- [x] Define the complete responsibility-state reconciliation table and deterministic evidence retention.
- [x] Define `chatJson` semantic-attempt maxima: 4 normal match attempts, 6 confirmation-path match attempts, and 8 full-analysis attempts including understand repair; existing bounded transport retries are outside this new feature and unchanged.
- [ ] Add `chatJson` semantic-attempt sequence tests for normal, confirmation, confirmation repair success, and confirmation repair failure paths.