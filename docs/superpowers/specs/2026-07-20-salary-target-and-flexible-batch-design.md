# Salary Target and Flexible Batch Design

## Goal

Keep BOSS acquisition broad enough to avoid missing suitable roles while making local ranking and default communication batches reflect the candidate's actual 9-14K target. Stop adding weak high-salary roles merely to reach an exact batch size.

## Confirmed Policy

- BOSS acquisition lane remains `10-20K` (`salary=405`). This is a platform search lane, not the candidate's expected salary.
- Candidate salary target becomes `9-14K`.
- Core salary fit: the job salary range overlaps 9-14K and its lower bound is at most 14K.
- Stretch salary fit: lower bound is 15-16K, but only as a soft opportunity when the role and experience remain plausible.
- High-salary backup: lower bound is at least 17K, or the role requires 3-5 years and its lower bound is at least 15K.
- High-salary backup roles remain visible but are never checked by default for communication.
- Default communication target is 30 roles, with 22 roles as the acceptable minimum.
- When 22-30 suitable roles are available, do not recommend another scan just to fill the gap.
- When fewer than 22 suitable roles are available, recommend at most one supplemental scan. The scan remains user-triggered so the existing BOSS risk controls are not bypassed.

## Data Flow

1. `resolveNativeFilterSnapshot()` continues to read `plan.platform.salaryLanes` and produce BOSS `salary=405`.
2. `profileToRuntimeConfigs()` reads `plan.salary` as 9-14K for local scoring.
3. `scoreJob()` classifies salary fit from parsed salary and experience, then adds one of:
   - `salary_target_core`
   - `salary_target_stretch`
   - `salary_target_high`
4. `decisionBucket()` keeps core roles eligible for primary/talk, forces high-salary roles to backup, and keeps stretch roles at talk or backup rather than primary.
5. `compareReportJobs()` uses salary-fit rank before model confidence so closer salaries appear earlier inside the same decision bucket.
6. The communication builder checks at most 30 primary/talk roles. It does not check backup roles.
7. The builder reports either `target range reached` or `supplemental scan recommended` using the 22-role threshold.

## Scope

### Included

- Salary-fit classification and ranking.
- Communication default selection capped at 30.
- Flexible target status on the communication builder.
- Updating the active local search plan to 9-14K while preserving BOSS `10-20K` acquisition.
- Regression tests for scoring, native filters, sorting, and builder defaults.

### Excluded

- Automatic BOSS navigation for a supplemental scan.
- New model calls.
- Hard rejection of every salary above 14K.
- Changes to communication pacing, daily limits, or risk-control behavior.

## Error and Safety Behavior

- Missing or unparseable salary remains `salary_unverified`; it is not silently treated as core fit.
- Salary classification never overrides existing hard blockers, inactive-job handling, or incomplete-detail refresh requirements.
- Supplemental scan advice is informational. It cannot start browser access by itself.
- Existing user confirmation remains required before a communication batch starts.

## Acceptance Criteria

- A 12-18K, 1-3 year role is core salary fit.
- A 15-20K, 1-3 year role is stretch salary fit and is not primary.
- A 15-20K, 3-5 year role is high-salary backup.
- A 17-25K role is high-salary backup regardless of experience.
- With more than 30 primary/talk roles, exactly the top 30 are checked by default.
- With 22-30 primary/talk roles, the UI says no supplemental scan is needed.
- With fewer than 22 primary/talk roles, the UI recommends one supplemental scan.
- A 9-14K candidate target still resolves to the BOSS `10-20K` lane when `platform.salaryLanes` contains `10-20K`.

