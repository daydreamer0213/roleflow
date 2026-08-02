# Role-central matching: 20-row live acceptance

Date: 2026-07-28

## Scope and controls

This run evaluated the role-central prompt and unchecked `backup` behavior on
the same 20 frozen private JD rows used by the earlier lightweight acceptance.

- Candidate product commit:
  `5e775a38b3b099192e7fe0a1eea7f2ce4fa15876`.
- Evaluated candidate commit:
  `e10727df3abfc4065437f3af9828266af9be052c`.
- Harness-only baseline commit:
  `9e105002d3130826f3ec865e3d7dc7a06ce37a11`.
- The profile, matching card, resume evidence, job set, labels, and model
  identity match the earlier 20-row bundle.
- The candidate used a new private bundle and fresh SQLite model cache.
- All work was serial.
- No BOSS or browser access occurred.
- No main operational database or port 8787 was accessed.
- No communication or application action occurred.
- This report contains no resume text, JD text, title, company, URL, source ID,
  endpoint, key, or model name.

Private artifacts are preserved outside the repository:

```text
D:\DevData\RoleFlow-private-benchmark\full-chain-v23-role-central-20-20260728
D:\DevData\RoleFlow-private-benchmark\full-chain-v24-role-central-empty-retry-20260728
```

Artifact identities:

| Artifact | SHA-256 |
| --- | --- |
| Original 20-row result | `DC4B99742AC737128E45EB2381E350EF85ED60D1A69E7C0857843D1891B8814A` |
| Run manifest file | `4EA245C509C3C53AFEFA2E89D4F1760B3D272C135D2DC1F1C2208BB8C4299C58` |
| Portability-proof file | `DD72B5C88376FA26A2142A0EE692F38A0905B60186F238BCD7BB888DA5DCE7CD` |
| Two-row retry result | `7DDF7D5A855841130B82D40CA2DC4A85DF257713ED2ACBC1D8DF657AB6FAC34F` |

## Original 20-row result

| Metric | Previous lightweight candidate | Role-central candidate |
| --- | ---: | ---: |
| Frozen rows | 20 | 20 |
| Complete analyses | 20 | 18 |
| Failed analyses | 0 | 2 |
| Exact recommendation and bucket | 16 | 5 |
| Recommendation accuracy | 80% | 65% |
| Bucket accuracy | 90% | 40% |
| Primary | 1 | 1 |
| Talk | 19 | 9 |
| Backup | 0 | 8 |
| Analysis pending | 0 | 2 |
| Retained opportunities | 20 | 18 |
| False hard exclusions | 0 | 0 |
| Hard-blocked rows | 0 | 0 |
| Evidence-free primary rows | 0 | 0 |

The two failed rows have the same failure signature:

- stage: `understandJob`;
- phase: `initial`;
- HTTP status: 200;
- response body length: 0;
- failure: invalid JSON because the JSON response envelope was empty.

This is model-service empty-response instability. It is not a contract-repair
failure and does not show that either JD deterministically breaks the prompt.

The original result is therefore **not a strict full-pass result**: it contains
two failed and unresolved rows.

## Controlled empty-response retry

The two failed indices were rerun in a separate private bundle with a fresh
cache. The original result was not edited or overwritten.

| Retry row | Recommendation | Bucket | Evidence | Result |
| --- | --- | --- | --- | --- |
| Empty-response retry 1 | caution | talk | complete | Pass |
| Empty-response retry 2 | review | talk | complete | Pass |

Both retries completed successfully. This demonstrates that the original
empty responses were transient service behavior.

For diagnosis only, replacing the two empty-response rows with their successful
retry rows produces this 20-row projection:

| Metric | Diagnostic projection |
| --- | ---: |
| Complete analyses | 20 |
| Failed, stale, pending, or partial | 0 |
| Primary | 1 |
| Talk | 11 |
| Backup | 8 |
| Retained opportunities | 20 |
| False hard exclusions | 0 |
| Unresolved dispositions | 0 |
| Evidence-free primary rows | 0 |
| Rows with complete two-sided evidence | 18 |

This projection is not written back as an acceptance result and is not used to
claim that the original single run passed.

## Backup review

The prior labels predate the new `backup` tier and mark all 20 rows as `keep`.
`backup` is still a retained opportunity, so old exact bucket accuracy alone
cannot decide whether the new behavior is useful.

The eight new backups were inspected through an offline cache replay. The
network adapter was replaced with a cache-miss failure stub; all 18 complete
rows replayed with zero network attempts.

Seven backups are directionally reasonable:

1. a UI/component-library and multi-device design role;
2. an image-generation workflow role;
3. an AI portrait and visual-design role;
4. a role requiring a specific alternate Agent platform plus frontend and
   business-process delivery;
5. a data-warehouse and SQL-optimization backend role;
6. a language-specific big-data-framework backend role;
7. an ERP and marketplace-API backend role.

One backup is probably a false downgrade. Its central requirements are broad
AI-tool practice and AI-code debugging. The confirmed candidate profile
contains concrete Agent, workflow-tool, logging, test, and debugging evidence,
but `matchJob` omitted those evidence rows and returned both central
requirements as unknown. The local guard then behaved exactly as designed and
sent the row to `backup`; the unstable part is the model's evidence selection.

Bucket transitions versus the earlier candidate:

| Transition | Rows |
| --- | ---: |
| talk to backup | 8 |
| talk to talk | 10 |
| primary to talk | 1 |
| talk to primary | 1 |

The role-central rule therefore filters several clearly adjacent roles, but
the likely false downgrade means it is not yet safe to declare the prompt
fully calibrated.

## Runtime and call accounting

- Original wall-clock time: 2,393.82 seconds, or 39 minutes 53.82 seconds.
- Previous lightweight candidate: 28 minutes 58.81 seconds.
- Original baseline: 20 minutes 55.50 seconds.
- The role-central run was about 1.38 times the previous candidate and 1.91
  times the original baseline, still below but close to the agreed two-times
  performance boundary.
- The two-row controlled retry took 361.37 seconds.

The cache contains 18 successful `understandJob` and 18 successful `matchJob`
records for the original run, plus four successful records for the retry.
These are successful cached stage results, not a complete billable API-call
counter. The full-chain runner does not persist contract-repair or internal
transport-retry telemetry, so this report does not claim an exact external
call count.

The long runtime was dominated by model-service variance. Several understand
stages took multiple minutes, and the two longest slow responses ended with
empty bodies.

## Decision

Do not merge based on the original strict result, and do not rerun all 20 rows
again yet.

The smallest next diagnostic change is limited to the sparse `matchJob`
evidence prompt:

- when a JD central requirement is a broad umbrella such as AI-tool practice
  or AI-code debugging, concrete Agent/workflow-tool/logging/test/debugging
  facts may satisfy it even if the wording is not identical;
- the model must still cite a concrete candidate fact;
- this must not turn specific missing platforms, visual workflows, data
  warehouses, big-data stacks, or ERP experience into matches.

After that prompt-only change, rerun offline prompt tests and use a fresh
two-row live check:

1. the probable false backup, which should return to `talk`;
2. one specific adjacent-role backup, which must remain `backup`.

Only then decide whether another 20-row run is worth its time and model cost.
