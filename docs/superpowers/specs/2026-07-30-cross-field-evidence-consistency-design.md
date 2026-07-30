# Cross-Field Evidence Consistency Design

## Goal

Reduce structurally valid but semantically inconsistent model variation without
weakening recall safety, hard eligibility boundaries, or the existing
cross-domain `caution` behavior.

## Observed failure

The immutable three-row run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-track-sprawl-v1-20260730`
proved that the previous change removed the false cross-track
`responsibility_sprawl` signal. All three rows were complete, evidence-bearing,
and free of contract, empty-response, and safety failures.

The run was not exact:

- index `4` had normal job quality and zero role gaps, but one central,
  indispensable, non-foundation requirement was `transferable`; the model
  recommendation remained `caution`;
- index `10` introduced a second eligibility item and marked it `conflict`,
  changing the recommendation from `caution` to `review`;
- comparison with the prior immutable cache showed that requirement
  decomposition and eligibility decomposition varied even though the frozen
  resume and JD bytes did not.

This is a cross-field consistency problem. A central `transferable` result with
no corresponding named role gap does not explain what remains unproved.
Likewise, splitting one eligibility sentence into independent hard gates can
change its logical alternatives or relaxation semantics.

## Options

### 1. Add prompt-level cross-field consistency rules (recommended)

Require central `transferable` evidence to identify the concrete unproved
difference in `roleGaps`. If there is no such difference and the resume fact is
a direct instance of a broad requirement, the state must be `matched`.

Require `understandJob` to preserve AND/OR and relaxation semantics when it
normalizes eligibility. It may emit separate eligibility items only when each
one is independently mandatory. Require `matchJob` to emit `conflict` only when
an explicit candidate fact fails every accepted alternative in that one item.

This corrects the inconsistency at its source while preserving validators and
local decision rules.

### 2. Promote transferable evidence in local policy

Local code could promote a mostly aligned role with no role gaps to `apply`.
This is rejected because it can hide a real named domain, platform, workflow,
or deliverable difference and would weaken the public cross-domain caution
fixture.

### 3. Ignore non-blocking eligibility conflicts locally

Local code could turn a non-hard eligibility conflict into `caution`. This is
rejected because the model may have found a real explicit conflict. The safer
fix is to preserve the source eligibility logic and make conflict evidence
internally consistent.

### 4. Change temperature or DeepSeek thinking policy

This is rejected for this checkpoint. Sampling changes affect all model tasks
and do not express the missing semantic invariant. The smallest root-cause fix
is an explicit contract instruction.

## Design

Add one `understandJob` instruction:

- preserve logical alternatives and scope when normalizing eligibility;
- do not split a combined or alternative sentence into independent hard gates
  if doing so changes AND/OR semantics;
- a relaxation, acceptable alternative, or example is not an independent
  gate;
- separate E items are allowed only when each condition is independently
  mandatory.

Add two `matchJob` instructions:

- a central `transferable` requirement must have a corresponding concrete named
  difference in `roleGaps`; if no such difference exists and the resume evidence
  is a direct instance of the broad requirement, use `matched`;
- do not invent a role gap to justify `transferable`;
- eligibility is `conflict` only when an explicit candidate fact fails every
  accepted alternative in the E item; satisfying any accepted alternative is
  `satisfied`, and uncertainty remains omitted.

Do not change:

- model result validators;
- local recommendation or bucket policy;
- hard-blocker evidence checks;
- model temperature, thinking, retry, or call count;
- private benchmark fixtures or confirmed labels.

Increment `understandJob` from `job-understanding-v16` to
`job-understanding-v17` and `matchJob` from `match-decision-v31` to
`match-decision-v32` so old caches cannot mask the change.

## Testing

Use TDD:

1. Add prompt assertions for eligibility logic preservation, central
   transferable/role-gap consistency, and the prohibition on invented gaps.
2. Update semantic pipeline expectations to v17/v32 and prove v16/v31 caches
   are stale for the correct reasons.
3. Run the focused adapter and semantic tests.
4. Run all six generic evidence fixtures, all 31 benchmark fixtures, all 47
   offline checks, and `git diff --check`.
5. Create a new immutable three-row root with a fresh cache. Do not create the
   20-row root unless indices `4,9,10` are exact and all safety gates pass.

## Privacy and safety

Tests and committed prompts use only generic language. No private title,
company, JD, resume fact, label rationale, model configuration, or API secret is
written to Git or console output. Live execution remains inside the reviewed
private runner and restores the fixed candidate worktree in `finally`.
