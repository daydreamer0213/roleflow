# Four-tier evidence promotion gates design

Date: 2026-08-02
Status: approved for implementation

## 1. Goal

Stabilize the four-tier recall-first decision path without changing the
user-approved direction-by-requirement decision matrix.

The behavioral acceptance target is:

- Every human-confirmed `primary` or `apply` job remains in the communication
  group.
- No human-confirmed `caution` or `not_recommended` job enters the
  communication group.
- `primary` and `apply` may differ without a behavioral failure.
- `caution` and `not_recommended` may differ without a behavioral failure.

The change must remain profession-neutral. It must not encode job titles,
technology names, fixture indices, or AI-application-specific concepts.

## 2. Evidence and root cause

The v4.3 full 20-job live run used non-thinking DeepSeek requests with
`temperature: 0`. It retained 8 of 10 communication jobs and incorrectly
promoted three caution jobs:

- Missed communication jobs: indices 5 and 8.
- False communication jobs: indices 11, 12, and 13.
- Technical failures: none.

The failures cannot be fixed by changing temperature because weighted-v1,
v4.1, and v4.3 all already force zero temperature for `understandJob` and
`matchJob`.

The current heavy-duty-gap threshold is discontinuous. A single model state
change between `transferable` and `missing` can move a job across the 50%
missing-ratio boundary. The v4.3 small and full runs demonstrated this exact
instability for indices 5 and 13.

The cached v4.3 full result exposes profession-neutral structural differences:

- Index 5 has confirmed duty gaps but also has a matched indispensable
  requirement and clears the existing joint-fit threshold.
- Index 8 has no confirmed duty gap; every known duty is at least
  transferable.
- Index 11 has two confirmed missing foundation requirements.
- Indices 12 and 13 have confirmed duty gaps and no matched indispensable
  requirement.

## 3. Considered approaches

### 3.1 Evidence promotion gates

Keep the matrix and replace the unstable heavy-gap recovery behavior with
explicit evidence gates. This is the selected approach.

Advantages:

- Uses existing structured evidence.
- Requires no extra model call.
- Adds no prompt instructions.
- Is deterministic after the model response.
- Generalizes across professions.

### 3.2 Roll back to weighted-v1

Weighted-v1 had the best historical full-run behavior before v4, but still
missed three communication jobs and falsely promoted index 13. It also lacked
the responsibility evidence needed to prevent that chronic false promotion.
It remains a historical comparison only.

### 3.3 Repeat model calls and vote

Repeated calls may reduce some random variation, but increase cost and latency
and do not guarantee consensus. This approach is rejected unless deterministic
evidence gates later prove insufficient.

## 4. Decision rules

The existing four-tier matrix remains authoritative. Model recommendation
continues in shadow mode and does not directly select the final tier.

### 4.1 Global foundation-missing ceiling

If any evidence-bound foundation requirement has state `missing`, cap the
final recommendation at `caution`, regardless of the reported role alignment.

An evidence-bound requirement has both JD evidence and resume evidence. This
preserves the existing evidence discipline and prevents unbound model labels
from activating the cap.

### 4.2 Zero-duty-gap promotion route

A `partially_aligned` role may be retained as `apply` when all of the following
are true:

- Responsibility evidence is present.
- At least the existing minimum number of duties are known.
- At least the existing minimum number of duties are positive.
- Responsibility coverage meets the existing minimum.
- No known responsibility has state `missing`.

Both `matched` and `transferable` are positive duty states. This route reflects
the recall-first policy: a candidate who can transfer into every known primary
duty should remain an opportunity even when secondary requirement extraction
is conservative.

This route floors the recommendation at `apply`; it must never promote a job
to `primary`.

### 4.3 Matched-indispensable promotion route

A `partially_aligned` role with one or more confirmed missing duties may still
be retained as `apply` when all of the following are true:

- At least one evidence-bound indispensable requirement has state `matched`.
- Responsibility evidence meets the existing known-count, positive-count,
  and coverage minimums.
- The responsibility-requirement joint fit meets the existing promotion
  threshold.
- No evidence-bound foundation requirement is missing.

This route also floors the recommendation at `apply` and must never promote a
job to `primary`.

### 4.4 Confirmed-duty-gap ceiling

For a `partially_aligned` role with one or more confirmed missing duties:

- If the matched-indispensable route is not ready, cap the recommendation at
  `caution`.
- A high aggregate requirement score alone cannot bypass this ceiling.

This prevents many secondary requirement matches from hiding a confirmed gap
in the primary work.

## 5. Precedence

The gates run in this order:

1. Compute existing weighted requirement, responsibility, coverage, and joint
   metrics.
2. Apply the global foundation-missing ceiling.
3. For a `partially_aligned` role, evaluate the zero-duty-gap route.
4. If duties are missing, evaluate the matched-indispensable route.
5. If neither route is ready, apply the confirmed-duty-gap ceiling.
6. Apply the existing matrix, coverage caps, and maximum promotion tier.

Safety ceilings take precedence over promotion floors. In particular, a
missing foundation can never be overridden by either promotion route.

## 6. Observability

Decision metrics must expose stable, non-sensitive fields for:

- Evidence-bound foundation missing count.
- Evidence-bound matched indispensable count.
- Zero-duty-gap promotion readiness.
- Matched-indispensable promotion readiness.
- Confirmed-duty-gap ceiling activation.
- The selected promotion route.

These fields contain counts, booleans, and stable enum values only. They must
not include JD text, resume text, model configuration, or identity data.

## 7. Versioning

- Bump `decisionRules` from `four-tier-weighted-v4.3` to
  `four-tier-weighted-v4.4`.
- Keep `matchJob` at `match-decision-v40` because the model contract and prompt
  do not change.
- Keep the four-tier recommendation schema and user-approved matrix unchanged.

## 8. Testing

Implementation follows test-first development.

Add failing regression cases before production changes:

- A missing foundation caps a `mostly_aligned` job at `caution`.
- A partially aligned job with all known duties positive is retained as
  `apply`.
- A partially aligned job with duty gaps and a matched indispensable
  requirement may be retained as `apply` when joint fit passes.
- A partially aligned job with a duty gap and no matched indispensable
  requirement is capped at `caution`.
- A safety ceiling cannot be overridden by a promotion route.
- Promotion routes never create `primary`.

Offline regression must include:

- Four-tier decision smoke tests.
- Four-tier pipeline smoke tests.
- Generic cross-profession evidence fixtures.
- Private runner smoke tests.
- Full offline `npm.cmd test`.
- Replay of the frozen v4.3 full 20-job cache.

The cached replay target is:

- 10 of 10 communication jobs retained.
- Zero non-communication jobs promoted.
- No change to the other 15 jobs' communication behavior.

## 9. Live acceptance

After offline review and evaluated-commit binding:

1. Run a fresh three-job diagnostic for zero-based indices 5, 8, and 13.
2. Publish a Chinese stage report with English field names annotated.
3. If the diagnostic passes structure, privacy, and behavior gates, run all 20
   jobs using a new directory and a fresh cache.
4. Publish the complete deviation list.
5. Acceptance requires zero missed communication jobs and zero false
   communication jobs.

Old run directories and caches remain immutable.

## 10. Out of scope

- Changing the user-approved decision matrix.
- Changing prompt text.
- Changing model temperature, thinking mode, provider, or model.
- Adding repeated model calls or voting.
- Adding profession-specific rules.
- Accessing BOSS or communication workflows.
