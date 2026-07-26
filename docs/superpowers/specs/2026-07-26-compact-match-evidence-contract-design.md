# Compact Match Evidence Contract Design

## Goal

Reduce `matchJob` output size and cross-field contradictions without reducing JD coverage, resume evidence, occupation generality, or the final product-quality gate.

The observed remaining live failure was intermittent `invalid_response_json`: the same frozen row failed once after the 8192-token recovery chain and then completed without a code change. Markdown cannot repair an invalid Chat Completions response envelope. The current match contract still creates avoidable latency and failure exposure because the model repeats fields already present in `jobUnderstanding` and also decides values that local code validates or overrides.

## Scope

This iteration changes only `matchJob`. `understandJob` keeps its current fields and array limits so that no JD facts or evidence are removed before a measured comparison.

Validated job understanding assigns deterministic IDs:

- `R1`, `R2`, ... for `coreRequirements`;
- `E1`, `E2`, ... for normalized eligibility constraints.

The model receives those IDs and returns only:

```json
{
  "matches": [
    {
      "id": "R1",
      "state": "matched",
      "resumeEvidence": "简历：相关事实短句"
    }
  ],
  "eligibility": [
    {
      "id": "E1",
      "state": "satisfied",
      "resumeEvidence": "简历：相关资格事实"
    }
  ],
  "uncertainties": [],
  "cautions": [],
  "certainty": "high"
}
```

Allowed requirement states remain `matched`, `transferable`, `missing`, `unknown`, and `not_applicable`. Eligibility states are `satisfied`, `conflict`, and `unknown`. Both arrays must cover the corresponding input IDs exactly once; duplicate, missing, or invented IDs fail the contract and may receive the existing single repair attempt.

Matched and transferable requirements require candidate evidence. Both satisfied and conflicting eligibility states require explicit candidate evidence. Unknown values never become hard blockers.

`cautions` is a small bounded list of `{kind,detail}` items. Its allowed kinds are `candidate_transition`, `preferred_gap`, `outcome_uncertain`, and `preference_conflict`. This preserves the decision effect of preferred requirements, outcome expectations, matching-card caution transitions, user notes, and search preferences without restoring the verbose decision payload.

## Deterministic derivation

Local code joins every match ID to the validated job understanding and restores:

- requirement label;
- indispensable flag;
- JD evidence;
- job quality and concerns.

Local code exclusively derives:

- `recommendation`;
- `fitLevel`;
- structured eligibility and indispensable-core blockers;
- `fitReasons`;
- `softGaps`;
- `questionsToVerify`;
- aggregate JD/resume evidence;
- recommended resume version;
- primary projects;
- greeting angle.

Decision order:

1. explicit eligibility conflict with candidate evidence -> `skip`;
2. JD safety or quality risk remains a JD-only risk and is handled by the existing rule guard, not disguised as candidate resume evidence;
3. unknown or missing indispensable information, no positive core evidence, any unresolved uncertainty, no core requirement, or low certainty -> `review`;
4. transferable evidence, a bounded caution item, caution-quality JD, or a non-core missing item -> at most `caution`;
5. complete direct evidence with normal JD quality -> `apply`.

`fitLevel` is derived as `D` for skip, `C` for review, `B` for caution, and `A`/`B` for apply based on high/medium certainty. Certainty may lower a result and may never raise one.

## Compatibility

- Bump only the `matchJob` pipeline version so old match caches are not reused.
- Keep the legacy MatchDecision validator as a read/fixture compatibility path.
- Normalize the compact MatchEvidence into the existing analysis view, so storage, dashboard, reports, communication drafting, and historical analyses do not require a database migration.
- Existing historical analyses remain unchanged and readable.

## Quality and safety boundaries

- Do not reduce the number of core requirements extracted from the JD.
- Do not remove JD or resume evidence from the normalized analysis.
- Do not turn unknown eligibility into a blocker.
- Do not manufacture a resume quote or “absence evidence” from a model `missing` state.
- Do not treat an eligibility item as satisfied without explicit candidate evidence.
- Do not allow unresolved `uncertainties` to enter the strongest recommendation bucket.
- Do not create fake candidate evidence for JD-only safety risks.
- Do not run the 20-row live gate until compact-contract offline regressions and a small private diagnostic pass.

## Verification

- Prompt shape test proves the model is no longer asked for recommendation, fit level, hard blockers, duplicated JD evidence, job-quality copy, resume version, projects, greeting angle, or aggregate evidence.
- Contract tests cover exact ID coverage, duplicate/invented/missing IDs, evidence requirements, eligibility conflict/unknown, and certainty.
- Semantic pipeline tests cover all deterministic decision branches and retain the existing rule guard.
- Generic multi-occupation fixtures and benchmark fixtures must remain green.
- A fresh one-to-five-row private diagnostic measures failure rate and elapsed time before any full live comparison.
