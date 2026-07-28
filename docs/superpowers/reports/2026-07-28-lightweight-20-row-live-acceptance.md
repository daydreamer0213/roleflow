# Lightweight recall-first matching: 20-row live acceptance

Date: 2026-07-28

## Scope and controls

This run compared the approved baseline and the lightweight candidate on the
same 20 frozen private rows.

- Both sides used the same confirmed profile, confirmed matching card, labels,
  model settings, runner files, and immutable run manifest.
- Both sides ran serially with separate fresh caches.
- The candidate commit was
  `e5d263d125ada517803f9c54c22cb9a881eb8f9d`.
- No BOSS or browser access occurred.
- No main operational database or port 8787 was accessed.
- This report contains no resume text, JD text, company, title, fixture ID,
  endpoint, key, or model name.

## Live results

| Metric | Baseline | Lightweight candidate | Change |
| --- | ---: | ---: | ---: |
| Frozen rows | 20 | 20 | 0 |
| Complete model analyses | 18 | 20 | +2 |
| Failed analyses | 1 | 0 | -1 |
| Locally blocked rows | 1 | 0 | -1 |
| Fully correct recommendation and bucket | 5 | 16 | +11 |
| Recommendation accuracy | 30% | 80% | +50 points |
| Bucket accuracy | 35% | 90% | +55 points |
| Expected `keep` rows | 20 | 20 | 0 |
| Retained opportunities | 7 | 20 | +13 |
| False hard exclusions | 12 | 0 | -12 |
| Unresolved dispositions | 1 | 0 | -1 |
| Evidence-free primary rows | 0 | 0 | 0 |
| Failed, stale, pending, or partial candidate rows | n/a | 0 | pass |

The candidate produced 17 `review`, 2 `caution`, and 1 `apply`
recommendations. Its buckets were 19 `talk` and 1 `primary`. Nineteen rows had
complete two-sided evidence; the only `primary` row had complete evidence, so
`primaryWithoutEvidence` remained zero.

## Timing

| Measurement | Baseline | Lightweight candidate |
| --- | ---: | ---: |
| 20-row wall-clock time | 1,255.50 s | 1,738.81 s |
| Wall-clock time | 20 m 55.50 s | 28 m 58.81 s |
| Successful understand-stage mean | 32.87 s | 49.57 s |
| Successful understand-stage median | 29.77 s | 40.46 s |
| Successful match-stage mean | 30.06 s | 37.37 s |
| Successful match-stage median | 26.14 s | 29.58 s |

The candidate wall-clock time was 1.38 times the baseline. Its mean measured
two-stage time was 86.94 seconds versus 62.93 seconds for successful baseline
stages, also approximately 1.38 times. This is below the agreed two-times
performance boundary.

The candidate had two slow service responses: the maximum understand stage was
168.94 seconds and the maximum match stage was 110.80 seconds. Despite that
variance, all 20 candidate rows completed.

## Comparator result

The offline comparator verified:

- full frozen coverage: 20/20;
- no excluded empty-response rows;
- identical fixture and provenance bindings;
- candidate accuracy improved by 55 points overall;
- candidate recommendation accuracy improved by 50 points;
- candidate bucket accuracy improved by 55 points;
- false hard exclusions fell from 12 to 0;
- candidate failed rows fell from 1 to 0.

The strict comparator status was:

```text
paired_fail
```

Its only failure reason was:

```text
baseline failed=1, and the failure was not an ignorable empty response
```

This is a baseline-input-completeness failure, not a candidate quality failure.
The candidate itself satisfies every recall-first candidate acceptance
condition: zero failed/stale/pending rows, zero unresolved dispositions, zero
false hard exclusions, zero missed obvious exclusions, and zero evidence-free
primary rows.

## Controlled baseline retry

One complete baseline stability retry was authorized in principle, using a new
bundle with a byte-identical manifest, portability proof, and copied immutable
candidate result.

The retry's first match stage failed to produce a cache entry, then processing
moved to the second row. At that point `failed=0` was already impossible, so
the retry process was stopped to avoid wasting further model calls. The
partial retry remains preserved and is not used as an acceptance result.

No third retry was attempted. The comparator was not changed or weakened.

## Decision boundary

The implementation demonstrates a large and consistent product improvement:

- 20/20 opportunities retained instead of 7/20;
- 0 false hard exclusions instead of 12;
- 20/20 complete candidate analyses instead of 18/20;
- recommendation and bucket accuracy both improved substantially;
- runtime stayed below the agreed two-times baseline boundary.

However, the previously defined strict merge gate has **not** passed because
the baseline input contains a non-empty-response failure. Merging therefore
requires one of the following explicit decisions:

1. accept a quantified exception because every candidate-side gate passed and
   the sole failure belongs to the old baseline; or
2. define and approve a new baseline-comparability rule before rerunning the
   comparator.

Until that decision is made, keep the candidate branch separate from the main
project.
