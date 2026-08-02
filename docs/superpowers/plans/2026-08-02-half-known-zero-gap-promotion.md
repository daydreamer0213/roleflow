# v4.6 Half-known zero-gap promotion implementation plan

> Execute only in `codex/multi-track-recall-continuation`. Keep BOSS and the
> production database untouched.

**Goal:** Restore index 8 recall by aligning the existing zero-confirmed-duty-gap
promotion gate with the base one-half responsibility coverage floor, without
changing the user-confirmed matrix or weakening confirmed-gap safety.

**Design:** Preserve the v4.5 model prompt and structured responsibility states.
Change one deterministic policy parameter, add explicit half-coverage and
confirmed-gap regressions, replay the frozen 20-job evidence, then run fresh live
3-job and 20-job acceptance in new private directories.

## Task 1: Record the failing behavior

1. Update the decision-policy version expectations to
   `four-tier-weighted-v4.6`.
2. Change the policy expectation for
   `zeroDutyGapMinimumKnownCoverage` from `2 / 3` to `0.5`.
3. Require a partial role with 2 transferable and 2 unknown duties to promote
   through `zero_duty_gap`.
4. Preserve or add a paired regression proving that 2 transferable, 1 missing,
   and 1 unknown duties do not promote.
5. Run the focused decision and pipeline smoke tests and observe RED before
   production edits.

## Task 2: Implement the single policy change

1. Set `DECISION_POLICY.version` to `four-tier-weighted-v4.6`.
2. Set `zeroDutyGapMinimumKnownCoverage` to `0.5`.
3. Set `PIPELINE_VERSIONS.decisionRules` to
   `four-tier-weighted-v4.6`.
4. Keep `PIPELINE_VERSIONS.matchJob = match-decision-v41`.
5. Do not change the prompt, contract, matrix, weights, thresholds, provider, or
   model settings.

## Task 3: Verify deterministic behavior

1. Run the focused four-tier decision, pipeline, semantic pipeline, and adapter
   smoke tests.
2. Run the generic benchmark fixtures, private runner smoke test, and complete
   offline `npm.cmd test`.
3. Run `git diff --check`.
4. Replay all 20 frozen jobs from the approved private evidence into a new v4.6
   offline directory.
5. Require zero missed expected communication opportunities and zero
   caution/reject jobs admitted to default communication.

## Task 4: Independent review and evaluated checkpoint

1. Generate a private review package without resume, JD, title, company, model
   configuration, or secret content.
2. Obtain independent spec-compliance and code-quality reviews.
3. Fix any Important or Critical finding before proceeding.
4. Commit the reviewed product and docs, record the exact evaluated checkpoint,
   and push the continuation branch.
5. Verify that the product commit is a strict ancestor of the evaluated
   checkpoint.

## Task 5: Fresh live acceptance

1. Reverify the frozen jobs and labels SHA-256 values.
2. Create
   `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-first-3-20260802`.
3. Run fresh indices `5,8,13` with a new cache.
4. Publish a beginner-readable Chinese stage report with English field
   annotations.
5. Stop before 20 jobs if any structural, bucket, empty-response, stale,
   pending, partial, evidence, or behavior gate fails.
6. After 3/3 passes, create
   `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-full-20-20260802`
   and run all 20 with another fresh cache.
7. Require all expected `priority` and `apply` jobs to remain selected and no
   expected `caution` or `reject` job to enter default communication.

## Task 6: Finalize

1. Update the decision matrix and matching plans with observed v4.6 evidence.
2. Rerun the final offline regression suite.
3. Obtain final independent review.
4. Commit and push every accepted checkpoint to GitHub.
5. Restore the live worktree to
   `codex/claude-generic-evidence-matching-live-fix` at
   `1fc49dac3670a71c720bfcaed943fa29204d93c5` and confirm it is clean.
