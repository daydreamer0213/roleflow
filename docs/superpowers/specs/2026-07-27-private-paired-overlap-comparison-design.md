# Private paired-overlap comparison design

## Context

The recall-first private fixture contains 20 frozen real-JD rows. A formal comparison normally requires the baseline and candidate to complete all 20 rows. The current model provider can occasionally return HTTP 200 with an empty response body before any product decision is made. Re-running every completed row only to recover one transport-empty row is expensive, while silently deleting failed rows would overstate coverage.

The user selected this policy:

- compare the same rows only where both sides have usable product decisions;
- keep the complete original results;
- report incomplete coverage explicitly;
- never call an overlap-only result a completed 20-row acceptance.

## Goals

- Produce a useful paired comparison when either side has a strictly identified content-free provider response.
- Remove the affected fixture row from both sides of the comparison denominator.
- Preserve the full 20-row source results and their stored summary validation.
- Distinguish overlap quality from full-fixture coverage.
- Keep every existing identity, privacy, confirmation and commit gate.

## Non-goals

- Do not ignore contract failures, product failures, stale rows, pending rows, partial rows or ordinary model disagreement.
- Do not modify or delete rows in either live result.
- Do not treat an incomplete overlap as formal acceptance.
- Do not add a general-purpose failure suppression policy.
- Do not import, rewrite or re-sign historical baseline outputs.
- Do not copy an old SQLite model cache into a new live run.

## Historical baseline reuse decision

The available historical results do not provide a directly reusable current baseline:

- one 20/20 baseline uses the v1 harness, old profile/card inputs and the old label contract;
- later v2-harness baselines use the current frozen job set, profile, matching card and model identity, but use the old labels and portability identity, and contain one failed row.

Labels do not drive the model request, so these results remain useful historical evidence. They do not satisfy the current comparator's immutable manifest, label, portability and evaluated-tooling identity. Adding cache migration or result re-signing would introduce more trust-boundary code than a fresh baseline run saves. The formal run therefore uses a fresh current baseline.

## Empty-response classification

A row is skippable only when all of these stored fields match:

- `semanticStatus === "failed"`;
- `errorCode === "MODEL_INVALID_RESPONSE"`;
- `responseHttpStatus === 200`;
- `responseContentLength === 0`;
- `responseContentTypeKind === "json"`;
- `responseEnvelopeKind === "empty"`;
- `responseFailureKind === "invalid_response_json"`;
- `failureStage` is `understandJob` or `matchJob`;
- `failurePhase === "initial"`.

The comparison does not inspect or persist a response body. Any missing diagnostic field, different error code, non-empty envelope, transport error, contract-repair failure, contract error or product-generated decision is not skippable.

## Pairing algorithm

1. Validate the baseline and candidate as complete, full-fixture live result files using the existing authorization, confirmation, worktree, commit, model, profile, matching-card, job-set, label and portability gates.
2. Validate every stored full-result summary against its 20 source rows before projecting an overlap.
3. Align rows by the existing opaque fixture ID.
4. Build `excludedEmptyIds` as the union of IDs classified as an empty response on either side.
5. Remove every ID in that union from both projected row arrays.
6. Recompute all benchmark and recall-first summaries from the projected rows.
7. Compare only the two projected arrays, which now contain the same fixture IDs.
8. Preserve the original full-result metrics separately in the report.

Example:

- baseline row 6 is empty;
- candidate row 14 is empty;
- rows 6 and 14 are excluded from both projected sides;
- `frozenTotal` is 20 and `comparableTotal` is 18.

## Report contract

The private comparison report adds:

```json
{
  "coverage": {
    "frozenTotal": 20,
    "comparableTotal": 18,
    "excludedEmptyTotal": 2,
    "baselineEmptyTotal": 1,
    "candidateEmptyTotal": 1,
    "bothEmptyTotal": 0,
    "fullCoverageComplete": false
  },
  "pairedAccepted": true,
  "accepted": false,
  "status": "paired_pass_full_incomplete"
}
```

Required status behavior:

- complete coverage and passing comparison: `status = "full_pass"`, `pairedAccepted = true`, `accepted = true`;
- incomplete coverage and passing overlap: `status = "paired_pass_full_incomplete"`, `pairedAccepted = true`, `accepted = false`;
- any comparable-row regression or non-skippable acceptance failure: `status = "paired_fail"`, `pairedAccepted = false`, `accepted = false`.

`accepted` remains the formal full-fixture gate. The CLI writes the JSON and Markdown diagnostic report for an incomplete but structurally valid overlap, then exits non-zero because `accepted` is false. This prevents automation from treating partial coverage as formal acceptance.

The console and non-sensitive handoff report use counts only. Private result files may retain the existing opaque ID change lists under the approved private benchmark root.

## Metric behavior

The paired projection recomputes:

- recommendation and bucket accuracy;
- failed, stale, pending and partial counts;
- primary-without-evidence and hard-false-placement counts;
- recall-first retained opportunities, false hard exclusions, obvious exclusions, missed obvious exclusions and unresolved dispositions;
- entered/exited `not_recommended`, entered `primary` and hard-blocker changes.

The original 20-row summaries are still validated and reported. The projected denominator is never substituted for `frozenTotal`.

The current confirmed fixture has 20 `keep` rows and zero `exclude` rows. It can measure opportunity retention and false hard exclusions. It cannot independently prove real-JD obvious-exclusion recall; existing synthetic eligibility, indispensable-core and safety fixtures continue to guard that behavior.

## Failure handling

- Zero comparable rows: structural comparison failure; no paired pass is possible.
- A non-skippable failed row: remains in the projected comparison and makes `pairedAccepted` false.
- Different full fixture sets or expected labels: existing identity/fixture failure; no report is accepted.
- Invalid stored summaries: existing metrics-integrity failure; no projected comparison is trusted.
- Empty response on both sides for one ID: exclude that ID once, increment both side counts and `bothEmptyTotal`.

## Test design

Add failing tests before implementation for:

1. baseline-only empty response;
2. candidate-only empty response;
3. both sides empty for the same row;
4. different empty rows on each side;
5. a contract error that must not be skipped;
6. an almost-empty overlap that cannot become formal acceptance;
7. zero comparable rows;
8. tampered full-result summaries rejected before projection;
9. a complete 20/20 comparison preserving the existing formal acceptance behavior;
10. CLI writes an incomplete-overlap report but exits non-zero.

The implementation should reuse the existing metric derivation and comparison functions. No dependency or new standalone preprocessing tool is needed.

## Execution after implementation

1. Run targeted comparator and private-runner smoke tests.
2. Run the complete offline suite.
3. Create a fresh immutable private bundle using the current baseline and candidate identities.
4. Run the current baseline over all 20 rows.
5. Run the candidate over all 20 rows.
6. Generate the paired/full comparison report.
7. Report safe counts only; do not print job, company, JD, resume, rationale, endpoint or key content.

The two live sides remain serial. No real recruitment platform, operational database or 8787 workbench is involved.
