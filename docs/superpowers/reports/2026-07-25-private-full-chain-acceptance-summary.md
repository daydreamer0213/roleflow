# Private full-chain acceptance summary

## Outcome

The private real-resume acceptance run completed, but the candidate **did not pass** the merge gate. No merge into the active product branch is permitted from this result.

## Frozen inputs and identities

- Candidate product commit: `7afb134edab09da2e6ac2354cff46d0cb03a1dfa`
- Candidate evaluated commit: `a828797049d0967c448a34995d6bd33fce85a821`
- Approved baseline product commit: `fb0168afce265cf351f03e80f66d9e0f24015887`
- Baseline evaluated commit: `2c11cd64fb5294a926b681acaaf4ff2414fba107`
- Model: `openai_compatible` / `deepseek-v4-pro`
- Reviewed job fixtures: 20
- Private result directory: `D:\DevData\RoleFlow-private-benchmark\full-chain-v3-20260726`

The candidate and baseline used the same frozen, redacted resume inputs, reviewed job fixtures, expected labels, benchmark harness, and model configuration.

## Live-model comparison

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Total | 20 | 20 |
| Passed rows | 11 | 9 |
| Failed analyses | 1 | 8 |
| Recommendation accuracy | 0.55 | 0.50 |
| Bucket accuracy | 0.55 | 0.50 |
| Primary without evidence | 0 | 0 |
| Hard false placement | 4 | 7 |
| False hard exclusion | 2 | 0 |
| Confirmed matching card consumed | No | Yes |

Comparator result: `accepted=false`.

The merge gate failed because the candidate had eight failed analyses, both accuracy metrics regressed, hard false placement increased, and new hard-exclusion misses appeared. These are product-quality failures, not a benchmark-harness or fixture-identity failure.

## Offline dashboard review

The candidate dashboard was started on a random local port with `--force-mock` and a private temporary database.

- The health endpoint returned HTTP 200.
- The downloaded PDF resume was extracted with `pdf_text_ordered`, was not truncated, and reported good section coverage.
- The model-send preview reported redactions for one phone number, one email address, and one name.
- Before matching-card confirmation, the dashboard displayed the confirmation requirement and disabled all four scan actions.
- After confirmation, the card status was `confirmed`, the active plan and card used the same profile version, and the local readiness guard returned `ready=true`.
- No scan action was clicked and no recruitment platform was accessed.
- The dashboard process was stopped, the random port was released, and its temporary database, logs, and resume copy were removed.

## Safety and integration decision

- No communication, application, or favorite action was performed.
- The active project database and port 8787 were not accessed.
- Model settings were read only through the approved settings root; secrets and endpoint contents were not copied into reports.
- Private resume text, identity, contact data, job bodies, and job URLs are excluded from this repository report.
- The optimization branch may be pushed for preservation and review, but it must not be merged into the active product branch until a new candidate passes a fresh full-chain comparison.
