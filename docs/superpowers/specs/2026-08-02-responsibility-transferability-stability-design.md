# Responsibility Transferability Stability Design

Date: 2026-08-02

## 1. Goal

Stabilize `responsibilityMatches` so a named tool, framework, platform, domain,
or specialist workflow difference does not randomly alternate between
`transferable` and `missing`.

The change must recover confirmed communication opportunities without allowing
partially observed responsibility sets to enter default communication.

## 2. Observed failure

The fresh v4.4 diagnostic completed without technical, privacy, cache, or
contract failures, but retained only two of three expected behaviors.

For zero-based index 8:

- A prior frozen run returned four transferable duties.
- The fresh run returned three transferable duties and one missing duty.
- The local v4.4 decision correctly applied the confirmed-duty-gap ceiling.
- The human label treats the named-tool depth gap as transferable and
  verifiable, not as a missing underlying delivery responsibility.

The comparison set proves that a numeric fit threshold alone cannot solve the
failure. Confirmed caution jobs have higher requirement fit and joint fit than
index 8. Lowering a threshold would therefore restore false communication.

## 3. Alternatives

### 3.1 Add a local numeric exception

Rejected. Existing scalar metrics do not monotonically separate the missed
opportunity from confirmed caution jobs. An exception would be fixture-specific
and unsafe across professions.

### 3.2 Add a new duty-gap severity field

Deferred. This would expand the model contract and prompt, add another unstable
classification, and increase the complexity the user explicitly wants to
avoid.

### 3.3 Clarify the existing state semantics and strengthen coverage

Selected.

- Keep the existing four responsibility states.
- Add one compact responsibility-specific instruction that distinguishes a
  named-context difference from a missing underlying responsibility.
- Require at least two-thirds known-duty coverage for the zero-duty-gap
  promotion route.

## 4. Responsibility state semantics

For every D1-Dn responsibility:

- `matched`: the resume proves the same underlying work action and deliverable
  in the required context.
- `transferable`: the resume proves the same underlying work action and
  deliverable through a different named domain, platform, tool, framework, or
  specialist workflow.
- `unknown`: the exact context is unproven and no comparable responsibility is
  evidenced. It must have empty `resumeEvidence`.
- `missing`: a concrete resume fact explicitly proves an incompatible
  responsibility, work action, or deliverable.

The absence of an exact named domain, platform, tool, framework, or specialist
workflow is not sufficient by itself to produce `missing`.

This rule is profession-neutral. The same semantics apply to software tools,
sales systems, accounting packages, design suites, manufacturing methods,
clinical workflows, or any other named context.

## 5. Local promotion gate

The `zero_duty_gap` route keeps its existing requirements:

- reported role alignment is `partially_aligned`;
- no evidence-bound missing foundation;
- at least two positive duties;
- no known missing duty;
- no existing safety ceiling.

Its minimum known-duty coverage changes from 0.50 to exactly 2/3.

This permits one unknown duty in a three-duty or four-duty set only when the
remaining evidence meets the existing positive-count gate. It blocks promotion
when half of a four-duty set remains unknown.

The `matched_indispensable` route and its joint-fit threshold remain unchanged.

## 6. Versioning

- Advance `decisionRules` to `four-tier-weighted-v4.5`.
- Advance `matchJob` to `match-decision-v41`.
- Keep the recommendation schema, four-tier matrix, 70/30 weights, model
  provider, model, temperature, thinking mode, and call count unchanged.

Both version changes invalidate prior analysis and match caches.

## 7. Testing

Use test-first development.

Add regressions that prove:

- The match prompt contains the responsibility-specific named-context rule.
- The prompt does not add a ninth top-level key or a repeated verification
  step.
- Zero-duty-gap promotion passes at exactly 2/3 known-duty coverage.
- Zero-duty-gap promotion fails below 2/3 known-duty coverage.
- The matched-indispensable route is unaffected.
- `decisionRules` and `matchJob` versions invalidate v4.4/v40 caches.
- The frozen v4.3 full cache still replays with zero missed and zero false
  communication under v4.5 local rules.

Run focused tests, all 50 offline checks, `git diff --check`, and independent
spec/code-quality review before a new live diagnostic.

## 8. Live acceptance

Preserve the failed v4.4 diagnostic root unchanged.

Use fresh roots:

- `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-first-3-20260802`
- `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-full-20-20260802`

Run zero-based indices `5,8,13` first. Only behavior 3/3 with all technical,
privacy, structure, and cache gates passing unlocks a fresh-cache 20-job run.

Full acceptance remains:

- all 10 confirmed primary/apply jobs retained;
- zero caution/not-recommended jobs in default communication;
- zero technical, privacy, structure, or stale-cache failures.

## 9. Out of scope

- Changing the user-approved matrix.
- Changing core/support 70/30 weights.
- Adding a new model field or model call.
- Repeated model self-checks, voting, or majority aggregation.
- Profession-specific keywords or fixtures in production rules.
- Changing labels.
- Accessing BOSS or communication actions.
