# Role-central bucketing: staged live acceptance

Date: 2026-07-28

## Scope and controls

This acceptance checked whether the new role-central evidence rule can keep
clearly adjacent but unsupported roles visible as unchecked `backup` items,
without making aligned roles disappear.

- The evaluated candidate commit was
  `bf5b0a463807099e597856e4d10afc3f78b375b0`.
- One saved-JD row was run first. After it passed, five fixed saved-JD rows
  were run serially.
- Every recorded row used the same approved formal model configuration, a
  fresh copied private database, and an empty analysis cache.
- No BOSS or browser access occurred.
- No main operational database or port 8787 was accessed.
- No communication or application action occurred.
- This report contains no resume text, JD text, company, URL, source ID,
  endpoint, key, or model name.

Private artifacts are preserved outside the repository under:

```text
D:\DevData\RoleFlow-private-benchmark\role-central-live-acceptance-20260728-01
```

Artifact identities:

| Artifact | SHA-256 |
| --- | --- |
| `single-job-r2.json` | `96554542B42C885698E6039F97D4200F39C5532C85D1BBB1E5DB804E4CF1F42F` |
| `five-jobs.json` | `87146145A5949C75803F05241230BD76DC4F8A8E207F181AF4B22C0E1C97D3CC` |
| Final private runner | `DA8F0D8564815559E1C2C4CB843EF3DCD2F4DF4B0258F148B85A0B88E3CF7EF3` |

The runner gained sanitized progress checkpointing between the one-row and
five-row stages. The one-row result therefore records the runner identity from
that earlier stage; the five-row result records the final runner identity.
This did not change the matching contract or acceptance rule.

## Live results

| Sanitized sample | Intended behavior | Actual result | Result |
| --- | --- | --- | --- |
| Target inference role | `backup`, unchecked | `review / backup`, unchecked; 0 of 2 central requirements supported | Pass |
| Mismatch vision role | `backup`, unchecked | `review / backup`, unchecked; 0 of 3 central requirements supported | Pass |
| Mismatch modeling role | `backup`, unchecked | `review / talk`, checked; 1 of 4 central requirements supported | **Fail** |
| Aligned agent role | Remain visible and checked | `review / talk`, checked; 4 of 4 central requirements supported | Pass |
| Aligned commerce-agent role | Remain visible and checked | `caution / talk`, checked; 2 of 4 central requirements supported | Pass |
| Junior boundary role | Remain visible; no hard exclusion | `review / talk`, checked; 2 of 6 central requirements supported | Pass |

All six recorded analyses completed. Each used exactly two model calls, had no
contract repair, had no cache hit, and produced no error.

The staged gate is **not accepted**. Five of six scenario expectations passed,
but the more important mismatch gate passed only one of its two rows. A
20-row run must not start from this result.

## Timing and call count

| Measurement | Result |
| --- | ---: |
| Recorded rows | 6 |
| Recorded model calls | 12 |
| Contract repairs | 0 |
| Median total elapsed time | 84.04 s |
| Median understand stage | 47.67 s |
| Median match stage | 26.24 s |
| Minimum row elapsed time | 28.06 s |
| Maximum row elapsed time | 147.18 s |

One initial single-row attempt completed both model stages, but its temporary
local summary step failed because it called workflow eligibility without a
required `now` value. That attempt produced no acceptance result and is
excluded from the table. Including those two discarded calls, this acceptance
used 14 external model calls in total. The failure was in the private runner's
post-processing, not in the product analysis.

Compared with the previously accepted lightweight single-row diagnostic
(107.59 seconds), the new six-row median was about 21.9% faster. Compared with
the prior 20-row lightweight run, the median understand stage rose from 40.46
to 47.67 seconds while the median match stage fell from 29.58 to 26.24
seconds. The sum of the two stage medians rose by about 5.5%, well below the
agreed two-times performance boundary.

The wide 28.06-to-147.18-second spread shows that model-service response time
still dominates runtime. The `central` rule itself is local computation and
did not add a third model call.

## Failed-row root cause

The failed mismatch row described a role centered on annotation-task
management, image processing, model-training assistance, and target-detection
knowledge.

The model marked four requirements as role-central:

1. generic Python programming;
2. image processing;
3. machine-learning training flow;
4. target-detection training.

Only generic Python was supported by the candidate evidence. The other three
role-specific central requirements were unknown.

The local guard currently sends a row to `backup` only when:

```text
central requirement count > 0
and
supported central requirement count == 0
```

Because generic Python was incorrectly treated as central and matched, the row
had 1 of 4 central requirements supported and bypassed the guard.

The prompt already says generic basic skills should not define an adjacent
role, but this live output did not follow that distinction reliably. The
observed failure is therefore prompt classification instability, not a parser,
cache, contract-repair, or workflow-checkbox bypass.

## Decision

Keep the implemented `backup` tier and unchecked workflow behavior. Do not
start the 20-row run yet.

The smallest next change is prompt-only:

- a programming language, operating system, database, office tool, generic
  data cleaning, or basic AI concept must not be `central` by itself;
- a central requirement must include the role-specific work or outcome, such
  as model training, image processing, target detection, Agent delivery, or
  RAG workflow delivery.

Do not add a deterministic percentage threshold yet. For example, a “less
than 50% central coverage becomes backup” rule would catch the failed mismatch
row, but it could also lower recall for junior and transferable candidates.
That would be a material product tradeoff and requires a separate user
decision.

After the prompt-only change:

1. rerun offline contract and workflow tests;
2. use a fresh copied cache to recheck the failed mismatch row and one aligned
   row;
3. request fresh live-model authorization for that recheck;
4. proceed to 20 rows only if both small-sample expectations pass.
