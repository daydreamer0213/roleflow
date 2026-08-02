# Role Central Evidence Recheck

## Scope

This report records a two-row saved-JD diagnostic after the role-central
20-row acceptance identified one probable false `backup`.

The diagnostic:

- reused the confirmed private profile, matching card, job set, and reviewed
  labels byte-for-byte;
- used fresh private bundles and fresh model caches;
- read the approved formal model settings without copying or printing secrets;
- did not access a recruitment site, browser session, production database, or
  dashboard;
- did not perform communication or application actions.

The two selected rows were:

1. the probable false `backup`, whose broad role-core requirement should accept
   narrower concrete candidate evidence;
2. a clear adjacent-role row, which should remain `backup` after calibration.

## First prompt-only attempt

Product commit:
`e45e0b2ca8d18e7fe3586521b0b5a3a50f4e2137`

Evaluated commit:
`d822b8ad42766adc6e6629fd1610ad5e58be8485`

Private result:
`D:\DevData\RoleFlow-private-benchmark\full-chain-v25-role-central-evidence-recheck-20260728\runs\candidate\match-result.json`

Result SHA-256:
`CC23D14184C5A720D9A55BB00D04D7BD89D1FA30E81E5381E91518CEDC2FD652`

The generic instruction to match by meaning rather than exact wording was not
specific enough for the live model:

- probable false backup: remained `review/backup`;
- adjacent-role control: remained `review/backup`;
- both rows were complete and evidence-complete;
- no row failed, became pending or partial, or received a hard exclusion.

The first row still had zero evidenced central requirements even though the
confirmed profile contained narrower concrete facts that were direct instances
of its broad requirement.

## Calibrated semantic example

The second prompt-only change added one explicit semantic-level example while
stating that it was not an occupation rule:

- concrete Agent, RAG, or workflow-tool delivery can prove broad AI-tool
  practice;
- concrete logging, testing, mock, exception-tracing, or API-debugging facts can
  prove broad AI-code debugging;
- the relation cannot be reversed to infer an unmentioned visual workflow,
  named platform, data warehouse, big-data framework, or business system.

No output field, contract, decision guard, model-call stage, or local threshold
changed. The `matchJob` cache version advanced to `match-decision-v22`.

Product commit:
`a6f62f4802a66219f9c149f0db7f88e5f32cdf7e`

Evaluated commit:
`057a7747231893a67158d926fc8f49d0cc78aa7a`

Private result:
`D:\DevData\RoleFlow-private-benchmark\full-chain-v26-role-central-evidence-recheck-20260728\runs\candidate\match-result.json`

Result SHA-256:
`02550F2208A4E8EF343B9DD0D868EE64B16BE72637A4CE49A028E37BB2C31C7B`

## Calibrated result

| Diagnostic row | Required behavior | Actual behavior | Central evidence |
| --- | --- | --- | ---: |
| probable false backup | restore to visible `talk` | `review/talk` | 1 of 3 central requirements |
| adjacent-role control | remain unchecked `backup` | `review/backup` | 0 of 2 central requirements |

Both rows:

- completed successfully;
- retained the opportunity;
- had no hard blocker or false hard exclusion;
- had no failed, stale, pending, or partial analysis;
- were evidence-complete.

The frozen reviewed labels expected both rows to be `talk`, so the generic
fixture summary reports one exact pass and 50% bucket accuracy. That is not the
acceptance definition for this targeted diagnostic: the second row was selected
specifically to prove that the calibration did not relax a clear adjacent-role
boundary. Against the predeclared diagnostic behaviors, both rows passed.

The calibrated run took 232.6 seconds for two rows, or about 116.3 seconds per
row. This is close to the earlier 20-row role-central average of about 119.7
seconds per row, so the additional prompt sentence did not show a material
runtime penalty in this sample.

The fresh cache contains two successful `understandJob` rows and two successful
`matchJob` rows. These are successful stage results, not an exact billable API
call count: the runner still does not persist contract-repair or internal
transport-retry telemetry.

## Decision

The focused evidence calibration is accepted for the two-row diagnostic:

- it recovered the probable false downgrade;
- it preserved the adjacent-role backup boundary;
- it did not weaken hard exclusions or add a model-call stage;
- it showed no material sample-level runtime increase.

A full 20-row rerun remains a separate cost and time decision. This report does
not claim full-set acceptance and does not authorize merging into the active
product checkout.
