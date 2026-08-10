# RoleFlow Shadow Scorecard Design

## Status and scope

This Wave 1.2 artifact is an offline feasibility tool only. It observes a
candidate scorecard beside existing results; it does not change formal
recommendations, decision buckets, default batch selection, production call
paths, the live database, or any browser/model behavior.

The focused regression command is:

```powershell
node tests/shadow_scorecard_smoke.js
```

## Pure interface

```js
buildShadowScorecard({
  roleAlignment,
  responsibilityMatches,
  requirementMatches,
  boundaries,
  risks
}, policy)
```

The function reads only its arguments and returns:

```js
{
  version,
  dimensions,
  evidenceCoverage,
  hardBoundary,
  score,
  candidateTier,
  reasons
}
```

The implementation does not mutate the input. `dimensions` keeps role,
responsibility, and core/supporting requirement diagnostics separate, but the
candidate tier is not computed by a second simplified ruleset. It calls the
existing pure production entry `deriveMatrixDecision` with the complete
verified semantic object (`roleAlignment`, `responsibilityMatches`, and
`requirementMatches`) and uses its `matrixRecommendation` as the candidate
tier. This preserves production responsibility consistency, alignment
consistency, zero-duty-gap promotion, matched-indispensable promotion,
foundation/duty-gap ceilings, core/coverage caps, and the approved matrix.
Unknown requirements are excluded from the fit denominator but remain in
coverage because that is the production entry's behavior.

The scorecard then applies only its offline-only inputs that are outside the
production pure decision signature: a verified hard boundary or severe risk
forces `not_recommended`, and a verified medium/high risk caps at `caution`.
These additions are diagnostics/guardrails for the shadow candidate and never
write or replace a formal recommendation.

## Initial candidate policy

The scorecard re-expresses the currently approved values; it does not propose
or activate replacement product policy:

- core/supporting requirement weights are 70/30;
- fit bands use 0.80 and 0.50;
- automatic-selection evidence coverage is 0.60;
- canonical tiers are `primary`, `apply`, `caution`, and `not_recommended`;
- the existing four-tier matrix supplies the unguarded candidate tier;
- verified hard boundaries and verified severe risks force
  `not_recommended`;
- verified medium/high risks cap at `caution`;
- low evidence coverage caps at `caution`;
- no declared core caps at `apply`, while an entirely unknown core caps at
  `caution`.

These are feasibility guardrails. A score never compensates for a hard
boundary, insufficient evidence, or a safety cap.

## Instability separation

Semantic instability is variation in `roleAlignment`, match states, or
evidence supplied by the semantic analyzer. It is represented in the input
dimensions and must be measured by replaying fixed semantic fixtures; the
scorecard does not call a model or claim to make semantic output deterministic.

Deterministic policy sensitivity is variation caused by changing a numeric
weight, threshold, matrix, or guard policy while replaying the same semantic
fixture. Each result records `policyVersion` and `policyHash` so later offline
comparisons can distinguish these changes from semantic variation. Wave 1.2
reports the approved policy only and does not search or activate a new one.

## Offline comparison CLI

The CLI requires both paths explicitly:

```powershell
node scripts/compare-shadow-scorecard.js `
  --input D:\DevData\RoleFlow-shadow-scorecard\synthetic-fixture.json `
  --output D:\DevData\RoleFlow-shadow-scorecard\baseline-report.json
```

The fixture is a JSON object with a `cases` array. Each case has an `id`, an
`input` matching the pure interface, and may carry the existing
`finalRecommendation`, `decisionBucket`, and `defaultSelectedForBatch` values
for comparison. An optional serialized policy is accepted for offline policy
experiments; when absent, the approved local policy is used.

The CLI rejects missing or duplicate case IDs, missing/non-array-object case
inputs, and input/output paths that resolve to the same Windows file through
case aliases, real paths, or file identity. It reads exactly the explicit
input file, sorts report rows by ID, and writes only the explicit output file.
It does not scan directories, open SQLite, mutate the fixture, call a
model/network/browser, or write any formal recommendation field.

## Verification and later decision

The smoke test proves deterministic replay, input immutability, hard-boundary
non-compensation, and low-coverage protection. Existing four-tier tests remain
the regression gate for formal matrix behavior. Suitability for a later
production shadow integration is a separate controller decision and requires
fresh approved fixtures, privacy review, latency measurement, and evidence that
the scorecard adds diagnostic value without changing formal outputs.
