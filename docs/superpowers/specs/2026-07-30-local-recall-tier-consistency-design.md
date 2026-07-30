# Local Recall Tier Consistency Design

## Goal

Make local recommendation and bucket guards reflect the already validated
decision-bearing evidence, while preserving every hard boundary and every real
central or foundation gap.

## Evidence

The immutable run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-field-consistency-v1-20260730`
was structurally and safely complete but exact on only one of three rows.

The prompt-level consistency change worked:

- index `4` had normal job quality, no hard blocker, all selected-track
  foundation and central requirements `matched`, and a cached local decision of
  `apply` with confidence `0.9`;
- index `10` had no eligibility conflict, a cached local decision of `caution`,
  and no hard blocker.

Two local guards then caused the remaining mismatch:

- `roleEvidenceDecisionState` caps every `mostly_aligned` result at `talk`, even
  when all foundation and central requirements have direct evidence;
- sparse confidence checks every omitted non-core requirement instead of only
  decision-bearing requirements, producing confidence `0.45` and triggering the
  existing low-confidence review guard.

## Options

### 1. Narrow local decision correction (recommended)

Allow a `mostly_aligned` role to retain a `primary` ceiling only when:

- foundation state is `complete`;
- no foundation requirement is merely `transferable`;
- no central requirement is merely `transferable`;
- no central or foundation requirement is `missing`.

Compute sparse confidence from unknown decision-bearing requirements, not
unknown non-core requirements.

This directly fixes both identified local inconsistencies and keeps
cross-domain, transferable-foundation, central-gap, eligibility, safety, and
low-evidence cases unchanged.

### 2. Add more prompt instructions

Rejected. The latest cache already contains the intended evidence states and
recommendations. More prompt text cannot fix deterministic local demotion and
would add model variance.

### 3. Globally promote mostly-aligned or low-confidence results

Rejected. Global promotion would weaken valid cross-domain caution and
insufficient-evidence review behavior.

## Design

In `validateSparseMatchEvidence`, replace the confidence condition based on all
`unknownRequirements` with `decisionUnknownRequirements`. Recommendation logic
already uses the decision-bearing subset; confidence must use the same scope.
Unknown eligibility remains unchanged.

In `roleEvidenceDecisionState`, compute an internal
`hasTransferableCentral` boolean. Extend the existing primary branch from only
`aligned` to `aligned` or `mostly_aligned`, but require:

```text
foundationState === complete
no transferable foundation
no transferable central requirement
no missing central or foundation requirement
```

Do not expose a new return field. Keep the current return shape and all backup
and talk branches.

Increment only `matchJob` from `match-decision-v32` to
`match-decision-v33`. `understandJob` stays at `job-understanding-v17`.

## Safety invariants

- Any validated hard blocker still produces `skip/not_recommended`.
- Any eligibility conflict with explicit evidence remains a hard boundary.
- Missing central or foundation evidence still caps at `backup`.
- Transferable foundation or central evidence still caps at `talk`.
- Medium/high risk, missing two-sided evidence, experience guards, and true low
  confidence remain unchanged.
- No model setting, prompt, validator schema, fixture, or confirmed label
  changes.

## Testing

Use TDD in `tests/semantic_pipeline_smoke.js`:

1. Change the complete direct `mostly_aligned` matrix case from `talk` to
   `primary`.
2. Add explicit cases proving transferable foundation, transferable central,
   and missing central evidence do not become primary.
3. Add a sparse validation case proving omitted non-core requirements do not
   lower confidence below `0.72`, while omitted decision-bearing requirements
   still do.
4. Assert v32 match caches are stale under v33.
5. Run semantic, six generic fixtures, 31 benchmark fixtures, all 47 offline
   checks, and `git diff --check`.
6. Use a new immutable three-row root and a fresh cache before any 20-row run.

## Privacy

The implementation and tests use only synthetic evidence. No private JD,
resume, title, company, eligibility text, model setting, or model response is
written to Git or console output.
