# Split semantic matching stability experiment plan

> This is an isolated private experiment. It must not modify or invoke BOSS,
> production databases, cookies, communication actions, or the live 8787
> service.

**Goal:** Determine whether one additional specialized model call improves
structural and behavioral stability enough to justify a production v4.7
architecture.

## Task 1: Bind the reproducibility evidence

1. Record identical model identity and frozen fixture hashes for v4.5/v4.6.
2. Record identical `understandJob` input hashes with differing outputs for
   indices 5 and 13.
3. Record the identical index 8 `matchJob` input hash with differing outputs.
4. Do not record prompts, job text, resume text, model settings, or secrets.

## Task 2: Build an isolated experiment runner

1. Place the runner under `.superpowers/sdd`; do not connect it to product
   commands or package scripts.
2. Require both private and live-model authorization environment gates.
3. Require a new output root under
   `D:\DevData\RoleFlow-private-benchmark`.
4. Load the confirmed private profile, matching card, and frozen jobs.
5. Resolve the existing runtime model configuration without printing it.
6. Reuse production `understandJob`.
7. Add minimal responsibility-only and requirement-only JSON calls through the
   existing adapter at temperature zero and non-thinking mode.
8. Validate IDs, states, evidence presence, and uniqueness locally.
9. Combine the two axes through the current deterministic rule guard.
10. Write full private experimental results and a separate sanitized summary.

## Task 3: Offline harness checks

1. Add an injectable fake adapter mode to exercise the three-call orchestration
   without network access.
2. Prove omitted rows become `unknown`.
3. Prove unknown, duplicate, and out-of-range IDs fail.
4. Prove no model recommendation can enter the local decision.
5. Prove summaries contain no prompt, job, resume, company, title, endpoint, or
   key content.

## Task 4: Run the bounded live experiment

1. Reverify frozen job and label SHA-256 values.
2. Use a new root:
   `D:\DevData\RoleFlow-private-benchmark\split-semantic-match-stability-v1-20260802`.
3. Run three independent repetitions of zero-based indices `5,8,13`.
4. Never share a model cache between repetitions.
5. Do not perform contract-repair or voting calls; each job uses exactly three
   semantic calls.
6. Preserve all outputs even if a call fails.

## Task 5: Report and decide

1. Publish a Chinese stage report with English field annotations.
2. Compare structural failures, state variance, behavior variance, latency, and
   output size against v4.5/v4.6.
3. If every acceptance gate passes, write a separate production v4.7 design and
   request independent review before implementation.
4. If any gate fails, do not add the third production call; design deterministic
   normalization and consistency ceilings instead.
5. Commit and push only sanitized docs and reusable non-private code. Never
   commit private experiment results.
