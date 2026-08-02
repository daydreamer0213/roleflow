# Central Transfer Gap Contract Design

## Goal

Fail closed when a central requirement is marked `transferable` without any
concrete role gap explaining the unproved difference.

## Evidence

The immutable run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-local-decision-consistency-v1-20260730`
improved to two of three exact. Index `10` became exact after the local
confidence correction. Index `4` remained `caution/talk`.

Its safe cache state was internally inconsistent:

- normal job quality, no concerns, no hard blocker;
- `mostly_aligned`, complete foundation evidence, and zero role gaps;
- one non-foundation central requirement marked `transferable`;
- final recommendation `caution`.

The match prompt already says a central `transferable` requirement must have a
corresponding concrete named difference in `roleGaps` and must not invent a gap.
The validator does not enforce that relation, so a structurally valid
contradiction reaches local policy.

## Options

### 1. Reject the contradiction and use the existing one-shot repair (recommended)

When any central requirement is `transferable` and `roleGaps` is empty, throw a
`ModelContractError` from sparse validation. Existing repair receives the safe
reason and must return either:

- a concrete role gap that explains the transferable state; or
- `matched` when the evidence is a direct instance and no difference exists.

This is fail-closed and does not silently promote evidence.

### 2. Normalize the central state to matched

Rejected. Local code cannot prove that the model forgot a real domain, tool,
workflow, work-object, action, or deliverable difference.

### 3. Ignore the inconsistency

Rejected. This is the current behavior and causes unstable, unexplained
demotion.

## Design

In `validateSparseMatchEvidence`, after the sparse requirement rows have been
joined to selected-track requirements, check:

```text
any requirementMatch has central === true and state === transferable
AND roleAlignmentEvidence.roleGaps is empty
```

If true, throw:

```text
central transferable requires a concrete roleGap
```

Do not include requirement labels, JD evidence, or resume evidence in the error.
The generic error is sufficient for repair and safe diagnostics.

Keep these cases valid:

- transferable central evidence with one or more concrete role gaps;
- transferable non-central evidence without a role gap;
- matched central evidence without a role gap;
- missing central evidence, which remains governed by existing backup/hard
  rules.

Increment only `matchJob` from `match-decision-v33` to
`match-decision-v34`.

## Testing

Add semantic TDD cases:

1. central `transferable` plus empty `roleGaps` fails with
   `MODEL_CONTRACT_INVALID` and the generic reason;
2. the same sparse row plus a concrete role gap validates and remains
   `caution`;
3. non-central `transferable` plus empty role gaps remains valid;
4. v33 match caches become stale under v34;
5. semantic, model adapter, six generic fixtures, 31 benchmark fixtures, all 47
   offline checks, and `git diff --check` pass.

Then run a new immutable three-row root with a fresh cache. Do not create the
20-row root until all three rows are exact and safe.

## Safety and privacy

The validation error contains no private text. No hard blocker, eligibility,
local bucket, model setting, prompt, fixture, or confirmed label changes.
