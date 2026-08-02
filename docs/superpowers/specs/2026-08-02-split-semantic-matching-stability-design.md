# Split semantic matching stability experiment design

## Status

Approved for an isolated experiment on 2026-08-02. This design does not yet
change the production matching pipeline.

## Confirmed root cause evidence

The v4.5 and v4.6 three-job runs used identical frozen fixtures and the same
model identity:

- job-set SHA-256 was identical;
- candidate-profile SHA-256 was identical;
- matching-card SHA-256 was identical;
- model-identity SHA-256 was identical;
- every corresponding `understandJob` input hash was identical.

Despite identical inputs:

- index 5 `understandJob` produced different output hashes and changed from 13
  to 15 requirements;
- index 8 `understandJob` output was byte-identical, and the corresponding
  `matchJob` input hash was also identical, but `matchJob` produced a different
  output hash;
- index 13 `understandJob` had the same input hash but a different output hash,
  which then changed its downstream match input.

This proves that fresh service responses are not fully reproducible at
temperature zero. It also proves that current product-version changes were not
the primary source of the observed semantic drift.

## Hypothesis

The combined `matchJob` call is overloaded. It simultaneously selects a track,
classifies up to four responsibilities, classifies up to sixteen requirements,
checks eligibility, reports role alignment and gaps, repeats resume evidence,
and optionally emits a shadow recommendation.

Splitting this work into two minimal evidence calls should:

- shorten each response;
- reduce omitted required evidence;
- stop requirement complexity from changing responsibility classifications;
- isolate failures to one decision axis;
- leave the deterministic four-tier decision in local code.

The experiment does not claim that an extra call makes the model deterministic.
It tests whether narrower tasks materially reduce structural and semantic
variance.

## Experimental architecture

Each job uses exactly three semantic calls:

1. `understandJob`: the existing production job-understanding call and
   production contract.
2. `matchResponsibilities`: select the hiring track when necessary and return
   only evidence-bearing D1-D4 responsibility states.
3. `matchRequirements`: use the selected track and return only evidence-bearing
   R and E states.

The two matching calls use temperature zero, non-thinking mode, JSON-object
transport, immutable IDs, and no model recommendation.

### Responsibility output

```json
{
  "selectedTrackId": "T1",
  "matches": [
    {
      "id": "D1",
      "state": "transferable",
      "resumeEvidence": "resume fact"
    }
  ]
}
```

Allowed states are `matched`, `transferable`, and `missing`. Unknown rows are
omitted and filled locally as `unknown`.

### Requirement output

```json
{
  "matches": [
    {
      "id": "R1",
      "state": "matched",
      "resumeEvidence": "resume fact"
    }
  ],
  "eligibility": []
}
```

Allowed requirement states are `matched`, `transferable`, and `missing`.
Allowed eligibility states are `satisfied` and `conflict`. Unknown rows are
omitted and filled locally as `unknown`.

Every emitted row must use an expected, unique ID and a concrete resume fact.
The experiment must not synthesize missing evidence.

## Local combination

The experiment derives role alignment from responsibility states:

- matched = 1;
- transferable = 0.5;
- missing = 0;
- unknown is unscored;
- the existing minimum known count, coverage, and alignment thresholds apply.

Requirements inherit `foundation`, `central`, `indispensable`, and JD evidence
from the validated job understanding. The existing production rule guard then
computes the final four-tier recommendation. The model never emits the final
tier.

If one split match call fails, the experiment records the failure. It must not
reuse a previous run, silently invoke the combined matcher, or fabricate a
four-tier result.

## Isolation and privacy

- Run only against frozen indices `5,8,13`.
- Do not access BOSS, cookies, 8787, or any jobs SQLite database.
- Read model settings only through the existing runtime settings gate.
- Do not print or copy settings, secrets, JD, resume, company, title, or model
  response text.
- Write private results only below
  `D:\DevData\RoleFlow-private-benchmark`.
- Preserve every run directory.
- Do not connect the experiment to the production analyzer.

## Measurements

For every call record only sanitized metadata:

- input SHA-256;
- output SHA-256;
- latency;
- output character count;
- structural pass/fail category;
- responsibility and requirement state counts;
- locally derived tier;
- expected tier and communication behavior.

## Acceptance decision

Run three independent repetitions for indices `5,8,13`.

The split architecture is eligible for production design only if:

- all 27 calls complete structurally;
- all three repetitions retain indices 5 and 8 in default communication;
- all three repetitions keep index 13 outside default communication;
- no repeated input hash produces a structurally incompatible result;
- no private text appears in the sanitized summary.

If the split experiment does not meet these gates, do not add the third
production call. Return to deterministic normalization and consistency ceilings
instead.
