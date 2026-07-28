# Role Central Evidence 20-Row Acceptance

## Scope

This report records the full 20-row saved-JD acceptance after the focused
evidence-calibration recheck.

The run:

- reused the frozen confirmed private profile, matching card, JD set, and
  reviewed labels byte-for-byte;
- used a fresh private bundle and fresh model cache;
- read the approved formal model settings without copying or printing secrets;
- did not access a recruitment site, browser session, production database, or
  dashboard;
- did not perform communication or application actions.

Product commit:
`a6f62f4802a66219f9c149f0db7f88e5f32cdf7e`

Evaluated commit:
`0ddec77b92d3e914bb05e0518620963b8aeedf31`

## Original 20-row result

Private result:
`D:\DevData\RoleFlow-private-benchmark\full-chain-v27-role-central-evidence-20-20260728\runs\candidate\match-result.json`

Result SHA-256:
`DE8773B30A70A749F0F93E0FF48301DDCCC2FD956B8BBD1D90879765314E0F0B`

Wall-clock time:
2,400.6 seconds, or about 40 minutes 1 second.

| Metric | Result |
| --- | ---: |
| Total rows | 20 |
| Complete rows | 16 |
| Failed rows | 4 |
| Primary | 1 |
| Talk | 8 |
| Backup | 7 |
| Analysis pending | 4 |
| Retained opportunities | 16/20 |
| False hard exclusions | 0 |
| Primary without evidence | 0 |
| Recommendation accuracy | 60% |
| Bucket accuracy | 35% |
| Exact recommendation-and-bucket passes | 3 |

The four failures were:

- one `matchJob` contract error that remained invalid after the single repair;
- one `matchJob` HTTP 200 response with an empty JSON body;
- two `understandJob` HTTP 200 responses with empty JSON bodies.

The run therefore failed the recall-first acceptance gate because `failed=4`
and `unresolvedDisposition=4`.

Runtime was effectively unchanged from the earlier role-central 20-row run,
which took about 2,393.8 seconds. The additional calibration sentence did not
create a measurable full-run slowdown.

## Controlled five-row retry

The retry used a fresh private bundle and fresh cache. It selected:

- the probable false backup;
- the one contract failure;
- the three empty-response failures.

Private result:
`D:\DevData\RoleFlow-private-benchmark\full-chain-v28-role-central-evidence-retry-20260728\runs\candidate\match-result.json`

Result SHA-256:
`1FE529379AFCB4EAA8EA56C3D6002B43EC9AEED19C3C199E12C369B5246F0D11`

Wall-clock time:
789.8 seconds, or about 13 minutes 10 seconds.

All five rows completed successfully on retry:

- no failed, stale, pending, or partial rows;
- no hard blockers or false hard exclusions;
- all five opportunities were retained.

This proves that all four original failures were recoverable model-service or
model-output variance rather than fixed product-contract failures.

The probable false backup did not recover in this retry. Across identical
saved inputs and the same calibrated product behavior, it produced:

- one `talk` result in the focused two-row recheck;
- one `backup` result in the full 20-row run;
- one `backup` result in the controlled five-row retry.

The same prompt therefore does not produce a stable role-core evidence choice
for this row.

## Diagnostic projection

Replacing only the four failed original rows with their successful retry rows,
without changing any other original row, gives:

| Metric | Projected result |
| --- | ---: |
| Total rows | 20 |
| Complete rows | 20 |
| Failed/stale/pending/partial | 0 |
| Primary | 1 |
| Talk | 11 |
| Backup | 8 |
| Retained opportunities | 20/20 |
| False hard exclusions | 0 |
| Primary without evidence | 0 |
| Recommendation accuracy | 55% |
| Bucket accuracy | 50% |
| Exact recommendation-and-bucket passes | 3 |

This projection is diagnostic only. It does not overwrite the original result
and is not a formal acceptance pass.

The projected distribution is the same as the earlier post-retry role-central
projection: one `primary`, eleven `talk`, and eight `backup`. The new prompt
did not improve full-set bucket accuracy, and recommendation accuracy decreased
from the earlier projected 60% to 55%.

## Root cause

The remaining false-backup instability is not a JSON-format problem and is not
fixed by a more explicit prompt example.

The compact `matchJob` contract deliberately permits the model to omit unknown
evidence rows. The local role-core guard then interprets the absence of a
positive `matched` or `transferable` central row as zero role-core evidence and
maps the job to `backup`.

This makes a product bucket depend on whether the model chooses to emit one
evidence row in a particular run. An omitted row can mean either:

- the candidate truly lacks relevant role-core evidence; or
- the model failed to select an existing narrower concrete fact.

Those meanings are not distinguishable in the current sparse output. Further
prompt-only tuning cannot make that boundary deterministic.

## Decision

The calibrated prompt is not accepted for merge into the active product:

- the full original run failed four rows;
- retries prove those failures are recoverable but still operationally costly;
- the probable false backup remains non-deterministic;
- full-set bucket quality did not improve.

Do not run another 20-row cycle with another prompt-only edit.

The next design must stop treating model omission as negative role-core
evidence. It should preserve the existing recall-first safety boundary, the
two-stage model architecture, and the explicit hard-blocker rules while making
the `talk` versus `backup` decision depend on a deterministic corroborating
signal rather than a missing sparse row.
