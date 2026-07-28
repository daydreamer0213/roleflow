# Role-central prompt adjustment: two-row live recheck

Date: 2026-07-28

## Scope and controls

This recheck evaluated the prompt-only adjustment that prevents generic skills
from independently defining a role's central work.

- Evaluated commit:
  `5e775a38b3b099192e7fe0a1eea7f2ce4fa15876`.
- Fixed rows: the previously failed mismatch row and one aligned control row.
- Both rows used a fresh copied private database with `model_cache` cleared
  from 40 entries to 0 before the run.
- The same approved formal model configuration was read without copying or
  printing its secret.
- No BOSS or browser access occurred.
- No main operational database or port 8787 was accessed.
- No communication or application action occurred.
- This report contains no resume text, JD text, title, company, URL, source ID,
  endpoint, key, or model name.

Private artifacts are preserved outside the repository under:

```text
D:\DevData\RoleFlow-private-benchmark\role-central-live-recheck-20260728-01
```

Artifact identities:

| Artifact | SHA-256 |
| --- | --- |
| `two-job-recheck.json` | `78F8A083F317418F3C5288157F2DF408F1CC580C89A7F4B6EED46274421C903C` |
| Private recheck runner | `59E8AF3E2014F0026653F2ACFFF3EAE20865592BD46AC3B3313696B7A752126E` |
| Final copied database | `FCD6C5E11809027B40C1E101FA5B7B7E41159262F67664DF3868D525BEA8AD91` |

## Results

| Sanitized sample | Previous result | Recheck result | Acceptance |
| --- | --- | --- | --- |
| Mismatch row | `review / talk`, checked; 1 of 4 central requirements supported | `review / backup`, unchecked; 0 of 1 central requirements supported | Pass |
| Aligned control row | `review / talk`, checked; 4 of 4 central requirements supported | `review / talk`, checked; 3 of 3 central requirements supported | Pass |

The prompt adjustment removed generic programming from the mismatch row's
role-central set. Its remaining central requirement describes role-specific
work and has no candidate evidence, so the existing local guard now sends the
row to the unchecked `role_core_backup` tier.

The aligned control retained three role-specific central requirements, all
with candidate evidence. It stayed visible and checked in `talk`, showing that
the prompt adjustment did not turn the control into a false backup.

Both acceptance expectations passed.

## Runtime

| Measurement | Mismatch row | Aligned control |
| --- | ---: | ---: |
| Understand stage | 55.29 s | 40.15 s |
| Match stage | 25.24 s | 19.71 s |
| Total elapsed | 80.56 s | 59.87 s |
| Model calls | 2 | 2 |
| Contract repairs | 0 | 0 |
| Cache hits | 0 | 0 |

The two-row total was 140.43 seconds, compared with 147.31 seconds for the
same two rows in the preceding five-row acceptance, a reduction of about
4.7%. The adjustment did not add a model call or contract repair.

## Decision boundary

The small live recheck passes the defined gate:

- the known mismatch is now an unchecked direction backup;
- the aligned control remains checked and visible;
- both rows completed without repair, cache reuse, or error;
- runtime and call count did not materially regress.

This result supports proceeding to the separately authorized 20-row saved-JD
acceptance. It does not itself authorize that larger run, and it does not
authorize BOSS access.
