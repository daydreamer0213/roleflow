# Multi-track sparse repair implementation plan

## Goal

Make the single `matchJob` contract repair converge after an output triggers
the strict multi-track sparse validator, without weakening validation or
changing unrelated repair behavior. Forwarding the invalid output may anchor
the repair on a legacy full-decision shape, but that remains a hypothesis to
test rather than an observed raw-output fact.

## Files

- Modify `src/adapters/models/openai_compatible.js`.
- Modify `tests/model_adapter_smoke.js`.
- Update the two authoritative benchmark plans after code review.

## Steps

1. Add failing assertions in `tests/model_adapter_smoke.js`.
2. Assert the match system prompt requires exactly the six sparse top-level
   keys and explicitly forbids legacy decision keys.
3. Stub `chatJson` and call `matchJob` with the exact complete validator message
   `matchJob 模型输出不符合契约：multi-track matching requires sparse evidence`.
4. Assert the model input omits `contractRepair.invalidOutput`, contains a fixed
   sparse-rebuild instruction, preserves authoritative inputs, and does not
   mutate the caller input.
5. Add a whitespace-padded form of the exact message and assert it also
   triggers the targeted preparation.
6. Add a non-sparse repair case and assert its input remains unchanged.
7. Add mixed, non-whitespace-prefixed/suffixed, and near-match negative cases
   and assert each preserves `contractRepair.invalidOutput` and the generic
   instruction.
8. Run `node tests/model_adapter_smoke.js`; it must fail before implementation.
9. Add one small input-preparation helper in
   `src/adapters/models/openai_compatible.js`.
10. Strengthen the existing sparse prompt with the exact allowlist and legacy
   denylist.
11. Use the prepared input only for `matchJob`; keep the strict
   `validateModelResult` call unchanged.
12. Run the focused test, then commit the product fix.
13. From a clean commit run `node tests/model_adapter_smoke.js`,
    `node tests/semantic_pipeline_smoke.js`,
    `node tests/job_match_benchmark.js`, `npm.cmd test`, and
    `git diff --check`.
14. Obtain independent review with no Critical, Important, or Moderate
    findings and explicit `Spec PASS` / `Code quality APPROVED`.
15. Before live work, record the exact candidate product commit and candidate
    evaluated commit. Verify the product commit is a strict ancestor of the
    evaluated commit. Keep baseline product
    `fb0168afce265cf351f03e80f66d9e0f24015887` and baseline evaluated
    `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` unless shared harness files
    change, and verify the same strict-ancestor rule.
16. Verify the continuation, candidate, and baseline worktrees are on their
    recorded branches and exact HEADs with clean status. Verify the
    runner/metrics/privacy blobs are identical between candidate and baseline.
17. Recheck frozen raw hashes: jobs
    `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
    and labels
    `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
18. Require the product-fix-specific three-row root
    `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v1-20260730`
    to be absent, then create it and copy the seven frozen fixture/evidence
    files from the approved source and confirmed pool. Verify every copied
    hash before generating the manifest and v3 proof.
19. Verify the manifest and v3 proof bind the recorded product/evaluated
    commits and pass the bundle verifier. Confirm the new root's cache,
    result, and output files are absent, then run exact zero-based indices
    `4,9,10` with a fresh cache.
20. In `finally`, restore
    `codex/claude-generic-evidence-matching-live-fix` at
    `1fc49dac3670a71c720bfcaed943fa29204d93c5` and assert its working tree is
    clean. Stop before 20 if any row is failed, pending, structurally
    incomplete, or violates the expected bucket/recommendation gates.
21. Only after the three-row gate passes, require the unique 20-row root
    `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
    to be absent. Repeat the create/copy/hash/manifest/v3-proof/bundle-verifier
    sequence and confirm cache/result/output absence before running all 20
    rows with a completely fresh cache; never reuse the three-row cache.
22. Restore the same fixed candidate branch and commit in `finally`, assert
    clean status, and retain both immutable result roots.

## Non-goals

- No validator relaxation.
- No local conversion of legacy decisions.
- No extra repair call.
- No BOSS access.
- No model config or private evidence logging.
