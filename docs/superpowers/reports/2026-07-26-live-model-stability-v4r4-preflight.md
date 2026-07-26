# Live model stability v4-r4 preflight

Candidate product commit: `73f2b26c1e6ebf1d510b11a13eea3f421576476d`

Harness: `private-full-chain-harness.v2`

The preserved v4-r3 comparison was correctly rejected. Raising the structured-output retry budget removed all ten truncation failures, but the candidate still produced nine invalid response-envelope failures and two contract failures. The result had 20 rows, 5 passes, 11 failures, 0.30 recommendation accuracy, and 0.30 bucket accuracy; it is not eligible for integration.

The v4-r4 repair keeps JSON as the machine contract and adds one bounded recovery request only after configured JSON-mode attempts end in invalid JSON or an invalid response envelope. The recovery request removes `response_format` while retaining the JSON-only instruction, the 8192-token cap, serial execution, and the full model-contract validation. It does not recover truncation-only, HTTP, timeout, or transport failures.

Safe diagnostics contain only an allowlisted response failure kind and the numeric requested output-token budget. Provider response text, prompts, model settings, endpoint, job content, resume content, and error bodies are not persisted.

Offline verification: adapter, semantic-pipeline, and private full-chain runner regressions passed; `npm.cmd test` passed all 47 offline checks; `git diff --check` passed; independent read-only review approved the repair after `finish_reason` and response-failure telemetry were restricted to explicit allowlists.

The next live gate must use a fresh single-parent baseline harness and a fresh private package with the same previously confirmed profile, matching card, 20 frozen jobs, and reviewed labels. Baseline and candidate run serially. Acceptance still requires candidate `failed=0`, no recommendation or bucket accuracy regression, and no hard-placement regression.

Safety boundary: the repair and preflight did not access a recruitment platform, browser, main database, port 8787, private content, or model-settings secrets. All earlier live packages and rejected reports remain preserved.
