# Lightweight recall-first matching: single-row diagnostic

Date: 2026-07-28

## Scope

This diagnostic evaluated one frozen private benchmark row after simplifying the
two-stage matching pipeline. It was diagnostic only:

- one candidate row;
- no formal baseline/candidate comparison;
- no BOSS or browser access;
- no main operational database or port 8787 access;
- no private resume, JD, company, title, identifier, endpoint, key, or model
  name is recorded in this report.

The evaluated candidate commit was
`dd030255ba65c7c6ede85444c6ba65ced58b46cc`.

## Offline gate

- Targeted contract, adapter, generic-evidence, and benchmark fixture tests
  passed.
- The complete offline suite passed: 47 of 47 checks.
- `git diff --check` passed.
- The candidate worktree was clean before the live diagnostic.

## Timing

| Measurement | Understand stage | Match stage | Wall-clock total |
| --- | ---: | ---: | ---: |
| Approved baseline, successful-row mean | 33.68 s | 24.39 s | 58.07 s |
| Old candidate, same frozen row | 357.47 s | 47.39 s | 404.86 s |
| Lightweight candidate, same frozen row | 56.50 s | 48.89 s | 107.59 s |

The lightweight candidate reduced total time by 297.27 seconds, or 73.4%,
relative to the old candidate on the same row. The understand stage fell by
84.2%. The match stage was effectively unchanged (+3.2%), so the measured gain
came from removing the pathological first-stage cost rather than hiding work in
the second stage.

The two cached stage timestamps account for 105.39 seconds of the lightweight
run. The 107.59-second wall-clock total additionally includes 2.20 seconds of
local runner, cache, validation, and result-writing overhead.

The lightweight total was 1.85 times the approved baseline successful-row
mean. This is still slower than baseline, but it is below the previously chosen
diagnostic stop line of roughly two times the baseline mean.

The cache stored normalized internal results of 1,563 characters for
`understandJob` and 2,568 characters for `matchJob`. These are post-validation
internal objects, not raw model responses, so they must not be used as a direct
measure of prompt or model-output verbosity.

## Quality and safety result

The single row:

- completed successfully;
- preserved the frozen `keep` disposition;
- produced `review` / `talk`, not a hard exclusion;
- had complete JD and resume evidence;
- had no hard blocker;
- had no failed, stale, pending, or partial state;
- had no evidence-free primary result;
- had no false hard placement or false hard exclusion;
- matched the frozen recommendation and bucket labels.

This is one sample only. It demonstrates that the simplified path can complete
with the intended recall-first behavior, but it is not a statistical acceptance
result.

## Decision

**GO to the frozen 20-row baseline/candidate acceptance comparison.**

Further prompt changes should not be made from this one timing sample. The
remaining match-stage latency may be model-service variance or a stable input
cost; the 20-row paired run is the appropriate way to distinguish those cases
while checking recall and false-exclusion behavior. If the paired run shows
repeated failures, false hard exclusions, or a stable total above the agreed
performance boundary, return to a small-sample optimization cycle.

The failed first launcher attempt is excluded from timing: PowerShell treated
Node's SQLite experimental warning as a fatal native error before any cache row
or result was written. The successful measurement used a fresh bundle and a
fresh zero-history cache.
