# DeepSeek Non-Thinking Single-Job Live Diagnostic

## Run Identity

- Candidate product commit:
  `c7e185234fa5e0ccc78931303d9df5ac256ce3c0`
- Candidate evaluated commit:
  `42c45931bbe7a4653c6100c55831c0c373a84c72`
- Harness-only baseline commit:
  `86679ca8cddfb312e4025a8c330319fb41b3d385`
- Private root:
  `D:\DevData\RoleFlow-private-benchmark\full-chain-v31-deepseek-nonthinking-single-20260729`
- Selection: frozen saved-job index 0 only
- Real model calls: yes, through the existing authorized model-settings gate
- BOSS/browser calls: none

## Safe Result

| Field | Result |
| --- | ---: |
| Rows | 1 |
| Semantic status | `complete` |
| Decision state | `ready` |
| Total analysis | 66,569 ms |
| `understandJob` | 10,810 ms |
| `matchJob` | 55,745 ms |
| Model calls | 2 |
| Model attempts | 2 |
| Contract repairs | 0 |
| Empty responses | 0 |
| Failed / pending / stale / partial | 0 / 0 / 0 / 0 |
| Matching card consumed | yes |
| Evidence complete | yes |
| Hard blocked | no |
| Role alignment | `misaligned` |
| Foundation state | `unproven` |
| Recommendation | `review` |
| Bucket | `backup` |

No prompt, JD, resume text, evidence excerpt, response body, model identity or
secret is included in this report.

## Before/After Interpretation

The immediately preceding fresh index-0 candidate run with thinking enabled
ended after 120,312 ms with two `understandJob` timeouts and never reached
`matchJob`.

With thinking disabled only for `understandJob`:

- extraction completed in 10,810 ms instead of failing after about 120 seconds;
- the complete two-stage flow finished in 66,569 ms;
- extraction elapsed time fell by about 91%;
- end-to-end elapsed time was about 45% lower even though the new run completed
  the additional `matchJob` stage;
- the remaining time is now concentrated in the unchanged `matchJob` stage
  (55,745 ms).

This comparison is a one-job diagnostic, not a population-level performance
claim.

## Quality Decision

The functional single-job gate passed:

- both semantic stages completed;
- no retry or contract repair was needed;
- evidence remained complete;
- no hard blocker was invented;
- the final `misaligned` + `unproven` + `backup` result matches the user's
  current manual judgment that this front-end-centered AI role should not be a
  main application target.

The row's benchmark `pass` field is false because the older frozen label still
expects bucket `talk`, while the current reviewed product decision is
`backup`. The frozen label was deliberately not changed during this transport
and latency fix. `acceptanceEligible` is false because the runner marks every
diagnostic subset as ineligible for full-batch acceptance; it is not a runtime
failure.

## Boundary Confirmation

- No BOSS page, browser or recruitment platform was accessed.
- No communication or application action occurred.
- The main project database and port 8787 were not accessed.
- Formal settings were used in place; settings and keys were not copied.
- Only one saved job was sent to the real model.
- The private cache and result remain outside Git.
- No 20-row run was started.
