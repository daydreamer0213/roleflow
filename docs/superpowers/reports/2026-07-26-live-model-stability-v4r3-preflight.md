# Live model stability v4-r3 preflight

Candidate product commit: `e4d9478b528e9959c6ab82a12a2f7c87674d9014`

Harness: `private-full-chain-harness.v2`

The v4-r2 comparison was correctly rejected after the candidate produced 10 truncated and 4 invalid structured responses. The repair preserves the first 4096-token request and raises only an already-permitted structured-output retry to at most 8192 tokens.

Offline verification: adapter red-to-green regression passed; model adapter, semantic pipeline, and private full-chain runner smoke tests passed; `npm.cmd test` passed all 47 offline checks; `git diff --check` passed; independent read-only review approved the repair.

Safety boundary: no platform access, main database, browser, port 8787, resume/JD/model response content, or model settings secret was accessed during the repair and preflight. The v4-r2 live results remain preserved and rejected.
