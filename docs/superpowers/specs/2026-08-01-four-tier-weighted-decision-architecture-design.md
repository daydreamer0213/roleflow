# RoleFlow Four-Tier Weighted Decision Architecture

> Status: approved in design discussion on 2026-08-01
>
> Scope: job-fit analysis, recommendation grouping, benchmark reporting, and
> default batch-communication selection
>
> This specification supersedes the proposed continuation of the temporary
> `adjacent_misaligned` solution and the use of three runtime buckets as the
> authoritative product grouping. It does not authorize access to live BOSS
> pages, communication actions, or migration of the live database.

## 1. Problem statement

RoleFlow must first remove clearly unsuitable jobs. Jobs that remain are split
by opportunity quality and communication behavior:

| Product tier | Canonical value | Meaning | Default batch selection |
|---|---|---|---|
| 主投 | `primary` | High fit and highest communication priority | Selected |
| 可投 | `apply` | Worth normal communication, with some non-fatal gaps | Selected |
| 慎投 | `caution` | Incomplete fit or uncertainty that needs user review | Not selected; user may select manually |
| 不推荐 | `not_recommended` | Clearly unsuitable or explicitly blocked | Not selected and ineligible by default |

The existing design has two sources of drift:

- The model-facing recommendation uses four values while runtime workflow
  buckets collapse results into three groups.
- The requirement-fit axis uses only a small core-requirement set, so one
  classification error can move the whole job while substantial ordinary
  requirements are ignored.

The replacement design keeps one product-facing four-tier vocabulary and
combines role direction with a code-computed weighted fit across core and
substantive supporting requirements.

## 2. Product invariants

- `primary` and `apply` are selected by default for a future communication
  batch.
- `caution` is retained for user inspection, is not selected by default, and
  may be selected manually.
- `not_recommended` is not selected and is not treated as a normal
  communication candidate.
- Technical analysis failure is not a recommendation tier.
- A missing resume mention is not automatically proof of incompatibility.
- An explicit preference or bonus is not a mandatory requirement.
- Normal matching decisions go through the two-dimensional decision matrix.
- Only verified hard boundaries and a small approved set of generic guards may
  override or cap the matrix result.
- Policy weights, thresholds, matrix cells, state values, rescue rules,
  workflow selection rules, and model-recommendation mode are protected
  product decisions. They cannot be changed without user approval.

## 3. Non-goals for the first implementation

- No live BOSS access or communication.
- No modification of `D:\Guo\ZhiPing` or its live `jobs.sqlite`.
- No bulk migration of historical records.
- No occupation-specific keyword dictionary.
- No new model call.
- No automatic search that writes a "best" policy into production.
- No new model semantic classification field unless weighted tuning proves the
  current evidence is insufficient.
- No implementation of a model recommendation mode that can affect the final
  tier.
- No attempt to force exact four-tier agreement on all 20 current AI-role
  samples.
- No prompt-compaction A/B until the first implementation is stable.

## 4. End-to-end architecture

The production path has seven bounded responsibilities:

1. Input integrity supplies the confirmed resume evidence and one complete JD.
2. Model semantic analysis converts natural language into structured facts.
3. Requirement classification derives hard, core, supporting, and soft groups.
4. The scoring engine computes fit and evidence coverage deterministically.
5. The decision matrix converts role direction and weighted fit into a base
   four-tier recommendation.
6. Verified hard boundaries and approved generic guards produce the final
   four-tier recommendation.
7. Workflow behavior derives default batch selection from the final tier.

The model interprets language. Code performs all arithmetic, table lookup,
policy enforcement, and workflow selection.

## 5. Analysis status is separate from recommendation

The analysis state remains operational metadata:

- `pending`
- `complete`
- `retry_required`
- `failed`
- `stale`

Only `complete` analysis may produce a final four-tier result.

Transport failure, empty output, unrepairable contract output, stale cache, and
incomplete JD capture produce no recommendation:

```json
{
  "analysisStatus": "retry_required",
  "finalRecommendation": null,
  "defaultSelectedForBatch": false
}
```

Semantic uncertainty after a technically complete analysis is different. If
the JD itself lacks enough information, the completed result may be capped at
`caution` and marked for human review.

## 6. Model responsibility

The model supplies semantic facts that deterministic code cannot infer
reliably across occupations:

- `roleAlignment`
- decomposed job requirements
- the existing importance flags such as `foundation`, `central`, and
  `indispensable`
- per-requirement match state
- JD evidence
- resume evidence
- structured risk and quality facts
- an optional four-tier holistic recommendation while shadow observation is
  enabled

The model does not calculate:

- core/supporting percentages
- evidence coverage
- the 70/30 weighted score
- the 80/50 fit bands
- the decision-matrix cell
- default communication selection

The normal direction vocabulary returns to:

- `aligned`
- `mostly_aligned`
- `partially_aligned`
- `misaligned`

`insufficient_evidence` remains an uncertainty state outside the normal four
matrix columns. The temporary `adjacent_misaligned` value is removed.
Substantive adjacent-role overlap belongs in `partially_aligned`.

## 7. Shadow model recommendation

The first implementation keeps the model's holistic four-tier recommendation
behind a policy mode:

- `off`: the model contract and prompt omit the holistic recommendation.
- `shadow`: the model emits it and reports record it, but it cannot affect the
  final result.

The initial policy uses `shadow`.

A future `guarded` mode is a reserved design option, not part of the first
implementation. It may be designed only after shadow evidence shows that the
holistic recommendation adds useful signal and the user approves the change.

Shadow output uses the same canonical four values:

- `primary`
- `apply`
- `caution`
- `not_recommended`

The benchmark compares shadow accuracy independently from matrix and final
accuracy.

## 8. Requirement classification without a new model field

The first implementation derives requirement groups from existing fields and
explicit JD language.

### 8.1 Verified hard boundary

A core requirement may form a hard blocker only when all required evidence is
present:

- the model marks the requirement as indispensable;
- the JD has an explicit, unambiguous, non-negotiable boundary;
- the resume or confirmed candidate evidence contains an explicit
  incompatibility.

Model `indispensable=true` alone never produces `not_recommended`.

### 8.2 Core requirement

A requirement is core when any existing flag is true:

```text
foundation || central || indispensable
```

### 8.3 Explicit soft or bonus item

Unambiguous phrases such as "优先", "加分", "经验优先", "熟悉优先",
"非必须", and equivalent soft language are normalized as non-mandatory.
Missing them does not reduce the fit score in the first implementation.

### 8.4 Substantive supporting requirement

A remaining requirement is initially treated as supporting when it is:

- not core;
- not a verified hard boundary;
- not an explicit soft or bonus item.

This group is intentionally lower weight. The first implementation does not
add a model field to distinguish a concrete supporting responsibility from a
generic personality phrase. Reports must expose supporting contributions. If
generic phrases materially distort real results and tuning cannot resolve the
problem, a separate field proposal must return for user approval.

## 9. Per-requirement state values

The initial deterministic values are:

| Match state | Value |
|---|---:|
| `matched` | `1.0` |
| `transferable` | `0.5` |
| `missing` | `0.0` |
| `unknown` | Excluded from fit denominator and counted as uncovered evidence |

`missing` must represent a supported negative judgment. Lack of text alone is
not sufficient to convert uncertainty into an explicit mismatch.

## 10. Fit and coverage calculation

For each declared group:

```text
knownCount = matched + transferable + missing
totalCount = knownCount + unknown
fitScore = sum(stateValue for known items) / knownCount
coverage = knownCount / totalCount
```

If `knownCount` is zero, the group's fit score is undefined and its coverage is
zero.

### 10.1 Both core and supporting groups are declared

When both group fit scores are defined:

```text
combinedFit = coreFit * 0.70 + supportingFit * 0.30
combinedCoverage = coreCoverage * 0.70 + supportingCoverage * 0.30
```

If one declared group has zero known items, code uses the defined group's fit
as a diagnostic fit value, retains the missing group's weighted zero coverage,
and applies the evidence-coverage cap. It does not invent a zero fit or divide
by zero. If both groups have zero known items, combined fit is undefined and
the completed semantic result is `caution` with an insufficient-evidence
reason.

### 10.2 Only core requirements are declared

```text
combinedFit = coreFit
combinedCoverage = coreCoverage
```

The absent supporting group does not reduce fit or coverage.

### 10.3 No core requirements are declared

The supporting group may provide the fit score, but the final result is capped
at `apply`. Absence of an identified core prevents an automatic `primary`
decision.

### 10.4 Declared core requirements are entirely unknown

Supporting evidence may still be reported, but the job cannot enter a
default-selected tier. The final result is capped at `caution`.

### 10.5 Evidence-coverage cap

The first policy uses:

```text
minEvidenceCoverageForAutoSelect = 0.60
```

When combined evidence coverage is below 60%, the final recommendation is
capped at `caution`.

## 11. Weighted-fit bands

The existing bands are retained for the weighted fit axis:

| Weighted fit | Band |
|---|---|
| `>= 0.80` | `fit` |
| `>= 0.50` and `< 0.80` | `mostly_fit` |
| `> 0` and `< 0.50` | `partial_fit` |
| `= 0` | `no_fit` |

Threshold changes require user approval and a report of every affected sample.

## 12. Supporting-evidence rescue boundary

The approved recall protection applies when:

- role direction is `misaligned`;
- known core fit is zero;
- there is no verified hard blocker.

Supporting requirements may preserve the job at `caution` only when:

```text
supportingFit >= 0.50
supportingCoverage >= 0.60
```

If either condition fails, supporting evidence alone does not rescue the
direction/core double mismatch from `not_recommended`.

Explicit bonus items and generic similarities are not intended to satisfy this
rescue boundary. Positive supporting items used by this rescue must have
contract-valid, reviewable JD and resume evidence; an unsupported personality
claim or shared generic phrase does not count as rescue evidence.

## 13. Authoritative two-dimensional matrix

The matrix uses role direction and weighted-fit band:

| Weighted fit \ Role direction | `aligned` | `mostly_aligned` | `partially_aligned` | `misaligned` |
|---|---|---|---|---|
| `fit` | `primary` | `primary` | `apply` | `caution` |
| `mostly_fit` | `primary` | `apply` | `caution` | `caution` |
| `partial_fit` | `apply` | `apply` | `caution` | `caution` |
| `no_fit` | `caution` | `caution` | `not_recommended` | `not_recommended` |

The supporting-evidence rescue boundary in Section 12 controls whether a
`misaligned` plus zero-core result may use a positive supporting band.

## 14. Decision precedence

The approved order is:

1. Technical failure returns no tier and schedules or records retry.
2. A verified hard blocker or verified severe safety risk returns
   `not_recommended`.
3. Normal jobs use weighted scoring and the matrix.
4. Approved generic guards may cap or lower the matrix result.
5. Workflow selection is derived from the final tier.

Approved generic guards may include:

- experience stretch lowering `primary` to `apply`;
- an indispensable requirement supported only by transferable evidence
  lowering `primary` to `apply`;
- verified medium/high risk capping the result at `caution`.

Responsibility sprawl alone remains a quality warning, not a recommendation
override.

The old count-based non-central-missing downgrade is removed because supporting
requirements already affect the weighted score. Keeping both would penalize
the same evidence twice.

Any new matrix override requires user approval.

## 15. Workflow derivation

Workflow behavior is derived, not stored as a competing recommendation bucket:

```text
primary         -> defaultSelectedForBatch = true
apply           -> defaultSelectedForBatch = true
caution         -> defaultSelectedForBatch = false, manual selection allowed
not_recommended -> defaultSelectedForBatch = false, ineligible by default
```

The product no longer treats `primary`, `talk`, and `backup` as the
authoritative recommendation vocabulary.

## 16. Versioned decision policy

One policy module is the authority for:

- canonical four-tier values
- matrix cells
- core/supporting weights
- per-state values
- fit thresholds
- evidence-coverage threshold
- supporting rescue threshold
- approved guards
- model-recommendation mode
- batch-selection derivation

Every decision result and benchmark report records:

```text
decisionPolicyVersion
decisionPolicyHash
```

Candidate policy search may report alternatives but cannot write or activate a
new production policy.

## 17. Cache separation

Model semantic cache and deterministic decision cache have separate
invalidation boundaries.

Model cache changes when:

- resume or JD input changes;
- model identity/configuration changes;
- model prompt changes;
- model contract changes;
- shadow recommendation presence changes the contract.

Decision cache changes when:

- decision policy version or hash changes;
- deterministic scoring or mapping code changes.

Changing 70/30 to another approved weight must not require a new model call.

## 18. Versioned compatibility

New records use a recommendation schema version and the canonical values:

```text
primary / apply / caution / not_recommended
```

Legacy records without the new version are interpreted at the read boundary:

| Legacy value | New canonical value |
|---|---|
| `apply` | `primary` |
| `caution` | `apply` |
| `review` | `caution` |
| `skip` | `not_recommended` |

No live database is bulk rewritten in this work.

Frozen private labels remain byte-for-byte unchanged. Benchmark code converts
legacy labels in memory and reports Chinese tier names to prevent English-value
ambiguity.

## 19. Benchmark reporting

Each row reports at least:

- reviewed expected tier
- shadow model tier, when enabled
- role direction
- core fit and coverage
- supporting fit and coverage
- combined fit and coverage
- matrix tier
- final tier
- default batch selection
- decision policy version/hash
- hard boundary and guard source
- mismatch severity and diagnostic reason

Offline candidate policies compare fixed semantic outputs. The initial coarse
grid is:

```text
80/20
75/25
70/30
65/35
60/40
```

The grid reports candidates only. It does not mutate the approved 70/30 policy.

Policy selection uses lexicographic product priorities:

1. Clearly unsuitable jobs must not enter `primary` or `apply`.
2. `primary` or `apply` opportunities must not become
   `not_recommended`.
3. Reduce default-selection boundary errors.
4. Improve exact four-tier agreement.
5. Prefer the simpler, more central policy when outcomes are otherwise equal.

## 20. Error severity

| Expected | Actual | Severity |
|---|---|---|
| `primary` | `apply` | Light |
| `apply` | `primary` | Light |
| `apply` | `caution` | Medium |
| `caution` | `apply` | Medium |
| `caution` | `not_recommended` | Medium |
| `not_recommended` | `caution` | Medium |
| `primary` or `apply` | `not_recommended` | Severe |
| `not_recommended` | `primary` or `apply` | Severe |

Acceptance is not defined only by an exact `18/20` count. Structural/privacy
gates and workflow behavior remain mandatory. Light and medium deviations are
reported by row. Severe deviations are product blockers.

## 21. Protected change-control workflow

Before changing a protected policy element:

1. Preserve the current result.
2. Show the affected benchmark rows.
3. Show model facts, current matrix result, candidate result, and reviewed
   expectation.
4. Quantify improvements and regressions by severity.
5. Explain why existing tuning cannot solve the issue when proposing a new
   field or prompt instruction.
6. Obtain explicit user approval.
7. Create a new policy version and hash.

This applies to matrix cells, weights, thresholds, state values, rescue
conditions, overrides, workflow selection, and model-recommendation mode.

## 22. Verification sequence

Implementation follows:

1. New policy and pure deterministic scoring tests.
2. All 16 matrix-cell tests.
3. Coverage, empty-group, rescue, hard-boundary, workflow, compatibility, and
   shadow-isolation tests.
4. Complete offline regression.
5. Fixed-cache candidate-policy report.
6. Independent read-only code review.
7. Fresh private three-row live acceptance using zero-based indices `4,9,10`.
8. Fresh-cache private 20-row acceptance only after the three-row run is
   structurally sound and has no severe deviation.
9. Final regression, review, documentation, commits, and push.

The already prepared directory
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v7-first-3-20260801`
is preserved but not executed because it binds the superseded design.

New live acceptance uses new roots:

```text
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-four-tier-v8-first-3-20260801
D:\DevData\RoleFlow-private-benchmark\multi-track-recall-four-tier-v8-full-20-20260801
```

No cache is shared between the three-row and 20-row runs.

## 23. Safety boundaries

- Do not access or operate real BOSS pages.
- Do not click communication or application actions.
- Do not read Cookie data.
- Do not start or operate port 8787.
- Do not read or write `D:\Guo\ZhiPing\data\jobs.sqlite`.
- Do not modify `D:\Guo\ZhiPing`.
- Model settings may be read only by the private runner at an authorized live
  step and must never be printed or copied.
- Private outputs remain under
  `D:\DevData\RoleFlow-private-benchmark`.
- The fixed candidate worktree is restored to its original branch, head, and
  clean status after every private preparation or run.

## 24. Deferred follow-up

After this architecture is stable:

- compare `shadow` and `off` for latency, output stability, and diagnostic
  value;
- decide whether to remove the holistic model recommendation or propose a
  separately approved guarded mode;
- perform prompt inventory and controlled prompt-compaction A/B;
- add non-AI occupation suites before claiming cross-occupation calibration;
- propose a new requirement-role field only if weighted tuning cannot separate
  substantive support from generic traits;
- design live-database migration as a separate, explicitly authorized task.
