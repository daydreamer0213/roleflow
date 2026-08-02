# DeepSeek Adaptive Job-Analysis Thinking: Live Acceptance

## Decision

Keep the experimental adaptive behavior on
`codex/deepseek-match-nonthinking-ab`:

- initial official DeepSeek V4 `understandJob` and `matchJob` requests disable
  thinking;
- an existing contract-repair request for either stage restores the provider's
  default thinking mode;
- no retry, timeout, prompt contract, setting, dependency or database schema
  was added.

Do not merge this branch into the primary optimization branch yet. This report
records experiment acceptance and preserves the branch for user review.

## Product Commits

- `558eb8e`: restore default thinking for `matchJob` contract repair;
- `ae201f9`: extend the same fallback to `understandJob` contract repair;
- `d977bce`: clean evaluated commit used by the final private live run.

## Offline Verification

- The adapter request-body test first failed because an official DeepSeek V4
  `understandJob` repair still sent `thinking: {type: "disabled"}`.
- After the one-condition fix, `node tests/model_adapter_smoke.js` passed.
- `npm.cmd test` passed all 47 offline checks.
- `git diff --check` passed.

The request-body test proves that both stages keep the fast initial path and
restore default thinking only when `input.contractRepair` is present.

## Staged Live Evidence

All runs used the same user-confirmed private profile, matching card and frozen
20-job fixture. Private inputs and outputs remained outside Git.

### Three-row diagnostic

- total: 3;
- incomplete: 0;
- retained opportunities: 3;
- median `matchJob` latency: 10,486 ms;
- false hard exclusions: 0;
- evidence-incomplete completed rows: 0.

### First 20-row adaptive-match run

- total: 20;
- complete: 19;
- failed: 1;
- retained opportunities: 19;
- median `matchJob` latency: 10,130 ms;
- false hard exclusions: 0.

The only failed row stopped in `understandJob` after its initial output and its
non-thinking repair output both violated the model contract. It never reached
`matchJob`. In the same run, index 9 triggered a `matchJob` contract repair;
the thinking-enabled repair completed with evidence and no hard blocker.

### Targeted index-11 rerun

- complete: 1/1;
- analysis elapsed: 19,339 ms;
- `understandJob`: 9,394 ms;
- `matchJob`: 9,894 ms;
- evidence complete: yes;
- hard blocked: no.

This rerun completed on the initial requests, so it did not trigger a live
understanding repair. The understanding-repair request-body behavior is
therefore verified offline, while the need for that fallback comes from the
first 20-row failure.

### Final fresh 20-row run

- complete: 20/20;
- failed/pending/partial/stale: 0/0/0/0;
- expected keep / retained opportunity: 20/20;
- opportunity retention rate: 1.0;
- unresolved disposition: 0;
- false hard exclusions: 0;
- primary results without evidence: 0;
- completed rows without evidence: 0;
- total analysis elapsed: 413,597 ms;
- median analysis latency: 17,935 ms;
- median `understandJob` latency: 8,141.5 ms;
- median `matchJob` latency: 10,495.5 ms;
- mean / p90 / maximum `matchJob` latency:
  12,139 / 14,811 / 44,444 ms;
- contract repairs: 1.

Index 9 again triggered one repair and completed with evidence, no hard blocker
and a conservative `review` / `backup` decision.

The final median `matchJob` latency is 81.7% below the observed 57,436 ms
default-thinking median, exceeding the required 40% reduction.

Exact frozen-label agreement was 0.60 for recommendation and 0.30 for bucket.
These exact labels are diagnostic, not the recall-first acceptance gate: all
20 fixtures are labeled keep opportunities, all 20 were retained, and no
incomplete or false hard-exclusion result remained.

## Nine-row Default-Thinking Cache Overlap

The final 20-row result was compared offline against all nine rows that had
both default-thinking understanding and matching cache entries:

- overlap: 9;
- automatic regressions: 0;
- evidence regressions: 0;
- new hard blockers: 0;
- recommendation changes: 2;
- bucket changes: 1;
- role-alignment changes: 1;
- foundation-state changes: 3.

The only role-alignment change moved from `partially_aligned` to
`mostly_aligned`; it retained evidence and moved from `review` / `backup` to
`caution` / `talk`. No paired row became incomplete or hard-blocked. Exact
recommendation or bucket equality was intentionally not required.

## Acceptance Gates

| Gate | Result |
|---|---|
| Offline adapter and full regression tests | Pass |
| Three-row diagnostic complete | Pass |
| Final 20-row run has no incomplete result | Pass |
| Final 20-row run has no false hard exclusion | Pass |
| All completed rows retain JD and resume evidence | Pass |
| Nine-row overlap has no automatic regression | Pass |
| Median match latency at most 30 seconds | Pass |
| Median match latency at least 40% below default thinking | Pass |

## Safety and Privacy

- No BOSS or browser access occurred.
- No communication or application action occurred.
- `D:\Guo\ZhiPing\data\jobs.sqlite` and the 8787 workbench were not accessed.
- Formal model settings were consumed only through the existing runner's
  `--model-settings-root D:\Guo\ZhiPing` boundary.
- No credential, formal setting, resume text, JD text, prompt or response body
  was printed, committed or pushed.
- Private artifacts remain under
  `D:\DevData\RoleFlow-private-benchmark`.
- The fixed candidate worktree was restored to
  `codex/claude-generic-evidence-matching-live-fix` at `1fc49da` and is clean.
