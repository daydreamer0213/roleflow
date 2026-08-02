# v4.6 Half-known zero-gap promotion design

## Status

Proposed on 2026-08-02 after the fresh v4.5 three-job live diagnostic.

## Problem

The v4.5 diagnostic kept indices 5 and 13 correct, but index 8 remained
`caution` instead of `apply`.

The live structured evidence distinguishes the two boundary cases:

| Sample | Responsibility states | Expected |
| --- | --- | --- |
| index 8 | 2 transferable, 2 unknown, 0 missing | apply |
| index 13 | 2 transferable, 1 missing, 1 unknown | caution |

The v4.5 semantic clarification correctly stopped treating unproven context as
confirmed missing for index 8. The remaining rejection came from
`zeroDutyGapMinimumKnownCoverage = 2 / 3`: two known duties out of four produce
only one-half coverage.

This is stricter than the base responsibility evidence floor even though the
route already requires at least two positive duties and zero confirmed missing
duties.

## Decision

Set `zeroDutyGapMinimumKnownCoverage` to `0.5`, equal to the existing base
responsibility evidence floor.

The `zero_duty_gap` route continues to require all of the following:

- the role is only `partially_aligned`;
- at least two duties are positively evidenced as `matched` or `transferable`;
- known responsibility coverage is at least one-half;
- no responsibility is classified as confirmed `missing`;
- the joint responsibility/requirement score reaches its existing threshold;
- no missing foundation requirement, low-coverage ceiling, hard blocker, or
  other existing safety ceiling applies.

An `unknown` duty remains unscored. It is not converted into positive evidence
and is not converted into a confirmed gap.

## Scope boundaries

This change does not alter:

- the user-confirmed role-direction by requirement-fit decision matrix;
- the 70/30 core/supporting requirement weights;
- requirement state values or fit thresholds;
- the responsibility semantic prompt added in v4.5;
- the model provider, model, temperature, or non-thinking mode;
- the number of model calls;
- the `matched_indispensable` promotion route;
- any hard-blocker, foundation-gap, low-coverage, or confirmed-duty-gap ceiling.

Only the deterministic coverage gate for the existing `zero_duty_gap` route
changes.

## Why this is preferable to another prompt change

Fresh v4.4 and v4.5 runs split the same JD into different numbers of
requirements, despite temperature zero. Repeatedly extending the prompt would
increase latency and prompt complexity without guaranteeing identical
segmentation.

The proposed change instead uses the already structured distinction between
`unknown` and `missing`. It trusts two positive duty judgments while preserving
the project's primary safety boundary: any confirmed missing duty still blocks
default communication through this route.

## Versioning

- Keep `matchJob = match-decision-v41` because the model prompt and contract do
  not change.
- Advance `decisionRules` and `DECISION_POLICY.version` to
  `four-tier-weighted-v4.6`.

## Acceptance

The implementation is acceptable only when:

- a partial role with 2 transferable and 2 unknown duties can reach `apply`;
- replacing either unknown duty with `missing` prevents that promotion;
- all existing promotion floors and safety ceilings remain green;
- the full frozen 20-job offline replay retains every expected communication
  opportunity and admits no expected `caution` or `reject` job;
- independent spec and code-quality reviews pass;
- a fresh live 3-job run for indices `5,8,13` passes all behavior and technical
  gates before any fresh 20-job run begins.
