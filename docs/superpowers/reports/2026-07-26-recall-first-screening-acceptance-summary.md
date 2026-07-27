# Recall-first screening acceptance summary

## Outcome

The isolated branch now treats job screening as an opportunity-retention step: it hard-excludes only explicit, evidence-backed incompatibilities while keeping experience-year gaps, wish-list gaps, transferable ability and ordinary uncertainty available for communication.

This is a bounded acceptance result, not a claim of perfect matching accuracy or a completed 20-row benchmark.

## Version identity

- Branch: `codex/claude-generic-evidence-matching-live-fix`
- Approved baseline product commit: `fb0168afce265cf351f03e80f66d9e0f24015887`
- Final evaluated product commit: `aafc5be17ea8d160f23bcdd386b5a1ffdb5a320b`
- Live evaluated checkpoint: pending the final v12 diagnostic
- Private harness: `private-full-chain-harness.v2`
- Label schema: `private-real-jd-labels.v2`
- Evaluation policy: `recall-first.v1`
- Job-understanding pipeline: `job-understanding-v9`
- Match-decision pipeline: `match-decision-v16`

## Confirmed labels

- Total confirmed rows: 20
- `keep`: 20
- `exclude`: 0
- Profile, matching card, resume evidence and job inputs were unchanged while the two remaining dispositions were corrected.
- True eligibility, indispensable-core and safety exclusions remain covered by synthetic offline fixtures.

## Latest bounded live diagnostic

- Rows evaluated: 3
- Completed: 3
- Opportunities retained: 3/3
- Result bucket: 3 `review/talk`
- Evidence complete: 3/3
- Failed, stale, pending, partial or unresolved: 0
- False hard exclusions: 0
- Missed obvious exclusions: 0
- Primary without evidence: 0
- Hard blockers: 0
- Confirmed matching card provided and consumed: yes
- Diagnostic mode: yes
- Formal acceptance eligible: no, by design for a three-row subset

This successful v11 result predates the final broad-review fixes in `aafc5be`; a fresh v12 run is required before the branch is published.

## Contract changes

- Inclusive or preference-only eligibility wording is removed from hard qualification inputs.
- Explicit cohort, education and certificate restrictions remain eligible for hard qualification checks.
- Mixed soft and hard qualification sentences keep the explicit hard qualification.
- A missing resume claim or a different technology stack is not direct incompatibility evidence.
- Epistemic wording such as “cannot confirm” remains unknown.
- Explicit candidate boundaries such as refusal, inability or a clearly limited responsibility boundary can still support an indispensable-core exclusion.

## Verification

- Regression tests were observed failing before the contract fixes and passing afterward.
- Targeted semantic, model-adapter, generic-evidence, benchmark and private-runner checks passed.
- The complete registered offline suite passed all 47 checks again after the final contract, review-coverage and documentation commits.
- Independent review findings on mixed qualifications, uncertainty wording and safe diagnostic-field projection were addressed or covered.

## Safety boundary

- No real recruitment platform was accessed.
- No communication or application action was performed.
- The main operational database and the 8787 workbench were not accessed or modified.
- Private profile, resume, job and model-response content stayed outside Git.
- Only the already authorized model settings entry was used for the bounded live diagnostic.
- No merge into the active main project was performed.

## Residual limits

- Three rows prove the corrected failure modes and the complete private chain, not overall precision across every occupation.
- Historical upstream JSON-envelope failures were intermittent; content-free envelope diagnostics remain available if they recur.
- The full 20-row live run was intentionally not executed.
