# Recall-first screening acceptance summary

## Outcome

The isolated branch now treats job screening as an opportunity-retention step: it hard-excludes only explicit, evidence-backed incompatibilities while keeping experience-year gaps, wish-list gaps, transferable ability and ordinary uncertainty available for communication.

This is a bounded verification result, not a claim of perfect matching accuracy, a fully passed three-row gate, or a completed 20-row benchmark.

## Version identity

- Branch: `codex/claude-generic-evidence-matching-live-fix`
- Approved baseline product commit: `fb0168afce265cf351f03e80f66d9e0f24015887`
- Final evaluated product commit: `ec781ee`
- Live evaluated checkpoint: `d376d666ad00f197713cf09ada29a2eb4b4d1438`
- Private harness: `private-full-chain-harness.v2`
- Label schema: `private-real-jd-labels.v2`
- Evaluation policy: `recall-first.v1`
- Job-understanding pipeline: `job-understanding-v9`
- Match-decision pipeline: `match-decision-v18`

## Confirmed labels

- Total confirmed rows: 20
- `keep`: 20
- `exclude`: 0
- Profile, matching card, resume evidence and job inputs were unchanged while the two remaining dispositions were corrected.
- True eligibility, indispensable-core and safety exclusions remain covered by synthetic offline fixtures.

## Final bounded live diagnostic

- Unique rows selected: 3
- Completed product decisions: 2
- Opportunities retained among completed decisions: 2/2
- Result buckets: 2 `review/talk`, 1 `analysis_pending`
- Evidence complete among completed decisions: 1/2
- Failed and unresolved: 1
- Stale, pending or partial: 0
- False hard exclusions: 0
- Missed obvious exclusions: 0
- Primary without evidence: 0
- Hard blockers: 0
- Confirmed matching card provided and consumed: yes
- Diagnostic mode: yes
- Formal acceptance eligible: no, by design for a three-row subset

The v13 three-row diagnostic received three upstream HTTP 200 responses with empty bodies and therefore produced no product decision. A fresh one-row v14 retry completed and exposed one false indispensable-core exclusion caused solely by a historical “participated only” responsibility boundary. Product commit `ec781ee` keeps historical role scope non-blocking while preserving explicit refusal or inability.

The v15 request again received an empty HTTP 200 response. The next fresh one-row v16 run completed as `review/talk` without a hard blocker, directly confirming the role-boundary correction. The final v17 three-row run completed two rows as `review/talk` with no hard blocker; the remaining row received an empty HTTP 200 JSON envelope at `understandJob`. A fresh v18 retry of only that row produced the same content-free upstream response after the adapter's retry sequence. The input had ordinary length and no invalid or control characters. No product decision was made for that row, so the branch does not claim a fully passed three-row gate.

## Contract changes

- Inclusive or preference-only eligibility wording is removed from hard qualification inputs.
- Explicit cohort, education and certificate restrictions remain eligible for hard qualification checks.
- Mixed soft and hard qualification sentences keep the explicit hard qualification.
- Hard eligibility decisions compare explicit facts instead of trusting a model-authored `conflict` state. Common cohort sets/ranges, in-school polarity, education thresholds, full-time study and named certificates are checked conservatively.
- Preference-only or uncertain qualification wording remains non-blocking, and satisfying one condition never hides another hard condition in the same sentence.
- A missing resume claim or a different technology stack is not direct incompatibility evidence.
- Historical responsibility scope such as only participating in one part of a project is an experience gap, not proof that the candidate rejects or cannot perform the core responsibility.
- Epistemic wording such as “cannot confirm” remains unknown.
- Explicit candidate boundaries such as refusal, inability or a clearly limited responsibility boundary can still support an indispensable-core exclusion.

## Verification

- Regression tests were observed failing before the contract fixes and passing afterward.
- Targeted semantic, model-adapter, generic-evidence, benchmark and private-runner checks passed.
- The complete registered offline suite passed all 47 checks after the final product contract and review-coverage commits.
- Independent review findings on mixed qualifications, uncertainty wording and safe diagnostic-field projection were addressed or covered.

## Safety boundary

- No real recruitment platform was accessed.
- No communication or application action was performed.
- The main operational database and the 8787 workbench were not accessed or modified.
- Private profile, resume, job and model-response content stayed outside Git.
- Only the already authorized model settings entry was used for the bounded live diagnostic.
- No merge into the active main project was performed.

## Residual limits

- The completed rows prove the corrected false-exclusion paths and the complete private chain, not overall precision across every occupation.
- The final three-row gate remains inconclusive because one frozen row repeatedly received an HTTP 200 response with an empty body before contract validation. The row remained `analysis_pending`; it was not falsely excluded.
- Content-free envelope diagnostics identify the upstream failure without persisting response bodies.
- The full 20-row live run was intentionally not executed.
