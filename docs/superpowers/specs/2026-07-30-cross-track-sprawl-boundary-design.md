# Cross-track responsibility-sprawl boundary design

## Status

Proposed from the immutable direct-instance v1 three-row evidence on
2026-07-30.

## Confirmed failure

The run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`
made indices `9` and `10` exact. Index `4` remained structurally complete at
`caution/talk`.

The direct-instance change worked: every decision-important requirement for
the selected track was `matched`. The only remaining downgrade was
`jobQuality.level=caution` with concern type `responsibility_sprawl`, produced
by `understandJob` and preserved by `matchJob`.

The same understanding correctly contained multiple independent hiring tracks.
Counting duties from different explicitly independent tracks as if one person
must perform them is a cross-track leakage bug.

## Constraints

- Keep responsibility-sprawl caution for an individual track that genuinely
  combines unrelated duties.
- Keep safety/compliance high-risk signals unchanged.
- Do not remove or locally override model risk signals.
- Do not add a private example or branch-specific keyword.
- Do not change match scoring, validators, model-call count, or thinking.
- Invalidate prior understanding and match caches affected by the prompt.

## Recommended change

Add one general rule to `understandJob`:

- after identifying explicit independent `hiringTracks`, evaluate
  `responsibility_sprawl` inside each track;
- do not combine duties from different independent tracks into one sprawl
  signal;
- a single track that itself mixes unrelated responsibilities still emits the
  existing low/medium signal.

This preserves the risk boundary while stopping another branch from lowering
the selected branch.

Because `understandJob` output changes, increment its pipeline from v15 to v16.
Because the downstream match input and cache identity also change, increment
the match pipeline from v30 to v31.

## Acceptance

- Prompt tests first fail on the missing within-track/cross-track distinction.
- Version tests first fail until understand v16 and match v31 are active.
- v15 understanding and v30 match revisions both become stale.
- Existing single-track responsibility-sprawl fixtures remain caution.
- Existing multi-track, adapter, semantic, 31 benchmark, all offline, and diff
  checks pass.
- A new three-row private root is required. All older roots remain immutable,
  and the 20-row root remains absent until all three rows pass.
