# Lightweight Recall-first Matching Design

## Goal

Reduce single-job model latency and contract-repair exposure while preserving the product boundary already confirmed by the user:

- exclude only jobs with explicit, evidenced hard conflicts;
- keep uncertain opportunities for review or conversation;
- require two-sided evidence before a job can enter the strongest recommendation bucket;
- preserve location, internship, salary-floor, user-exclusion, eligibility, indispensable-core, and safety boundaries.

This is a focused reduction of the candidate pipeline. It does not change browser access, BOSS behavior, the main database, port 8787, resume onboarding, matching-card confirmation, or communication execution.

## Evidence behind the change

The frozen private run showed that the candidate still performs two serial model stages per job, as does the approved baseline. The regression is inside those stages:

- the candidate `understandJob` prompt and valid output are roughly twice the baseline size;
- the candidate `matchJob` output is also materially larger;
- the candidate repeats the raw JD, structured job understanding, candidate profile, matching card, resume-version facts, and search preferences in the second request;
- strict validation of display and soft-preference fields can trigger a full second model request containing the original input, invalid output, and repair instructions;
- on the selected already-completed private row, the old candidate took about 405 seconds: about 357 seconds in `understandJob` and 47 seconds in `matchJob`.

The baseline is faster because it asks for fewer fields and accepts a much simpler shape. Its occupation-specific assumptions are not restored: the current recall-first labels show that those assumptions also created false hard exclusions.

## Considered approaches

### Collapse the pipeline to one model call

This offers the lowest theoretical call count, but couples JD understanding to one candidate, removes reusable JD-understanding cache value, and creates a larger behavioral rewrite. Rejected for this iteration.

### Increase model concurrency

This may improve batch wall-clock time but does not reduce single-job cost, invalid output, retries, or repair requests. It also makes provider-rate behavior harder to interpret. Rejected until single-job cost is fixed.

### Keep two stages and make both decision-minimal

Chosen. It preserves the current cache boundary and downstream analysis shape while removing duplicated inputs and non-decision output.

## Stage 1: compact job understanding

`understandJob` returns only information needed to make a conservative screening decision:

```json
{
  "roleSummary": "one short optional summary",
  "requirements": [
    {
      "label": "core requirement",
      "indispensable": false,
      "evidence": "JD: short source quote"
    }
  ],
  "eligibility": ["JD: explicit cohort, education, or certificate condition"],
  "riskSignals": [
    {
      "type": "fee_fraud",
      "severity": "high",
      "evidence": "JD: short source quote"
    }
  ]
}
```

Local code assigns stable `R*` and `E*` IDs and normalizes this compact result into the existing internal `JobUnderstanding` shape. Existing downstream consumers continue to receive `coreRequirements`, `eligibilityItems`, `hiddenRisks`, and `jobQuality`.

The model no longer emits separate responsibilities, preferred requirements, outcomes, seniority, evidence-snippet copies, business scenario, or nested quality concerns for every job. Those fields are non-blocking in the recall-first screen and overlap the retained requirements or risks. Compatibility fields remain present internally as empty arrays or derived values.

Missing optional fields default conservatively. Invalid evidence-bearing objects remain contract errors and may use the existing single repair attempt; an invalid hard exclusion is never accepted.

## Stage 2: sparse match evidence

`matchJob` receives:

- the structured candidate profile;
- the confirmed matching card;
- compact job understanding;
- small search preferences.

It no longer receives the raw JD again or duplicated resume-version/profile copies.

The output contains only evidence-bearing rows:

```json
{
  "matches": [
    {
      "id": "R1",
      "state": "matched",
      "resumeEvidence": "Resume: short factual quote"
    }
  ],
  "eligibility": [
    {
      "id": "E1",
      "state": "conflict",
      "resumeEvidence": "Resume: explicit conflicting fact"
    }
  ]
}
```

`matches` may use `matched`, `transferable`, or `missing`. `missing` is accepted as a hard conflict only for an indispensable requirement with explicit incompatibility evidence. `eligibility` may use `satisfied` or `conflict`; conflict is accepted only when the existing deterministic eligibility checker verifies it.

Rows may be omitted. Local code treats every omitted `R*` or `E*` item as `unknown`. Therefore incomplete model output keeps the opportunity under review instead of triggering a false exclusion or requiring the model to restate every unknown item.

## Deterministic decision

Local derivation keeps the existing downstream analysis shape:

1. verified eligibility conflict or evidenced indispensable-core conflict -> `skip`;
2. safety-risk JD -> existing safety guard;
3. omitted/unknown requirement or eligibility, no positive evidence, or no extracted requirement -> `review`;
4. transferable evidence or non-core explicit gap -> `caution`;
5. all extracted requirements directly evidenced and all eligibility satisfied -> `apply`.

Confidence is derived locally from completeness. The model does not emit recommendation, fit level, confidence, cautions, uncertainties, hard blockers, duplicated JD evidence, or display text.

## Versioning and compatibility

- Bump both job-understanding and match-decision pipeline versions.
- Do not migrate the database.
- Historical analyses remain readable.
- Old model-cache entries are not reused for the new contract.
- The legacy verbose validator remains available for historical fixtures and stored analysis compatibility.

## Tests

Test-first coverage must prove:

- the new prompts request only the compact shapes;
- stage 2 no longer receives raw JD or resume-version duplicates;
- omitted match and eligibility IDs become `unknown` rather than causing repair;
- explicit conflicts still require valid candidate evidence;
- uncertain rows remain `review/talk`;
- complete direct evidence can still become `apply/primary`;
- safety and deterministic hard boundaries remain unchanged;
- targeted smoke tests and the full offline suite pass.

## One-row live diagnostic

After offline verification, run only the previously completed candidate row at frozen index 1 with a fresh output directory and cache.

Report only aggregate, non-private values:

- per-stage and total elapsed time;
- adapter attempts and contract-repair count;
- output character counts;
- semantic status, recommendation, bucket, evidence completeness, and hard-blocker count.

Compare the result with:

- the old candidate result for the same row: about 405 seconds total;
- the baseline successful-stage average: about 56 seconds per two-stage job;
- the frozen user disposition for that row, without printing JD, company, title, resume text, or identifiers.

One row is a diagnostic, not formal acceptance. It decides whether another small optimization is needed or whether the 20-row comparison is worth running.

## Safety

- Do not access BOSS or any recruitment platform.
- Do not operate a browser, the main database, or port 8787.
- Use the existing read-only model-settings gate; do not copy or print keys, endpoints, model names, private resume text, JD text, or identifiers.
- Write private live outputs only under `D:\DevData\RoleFlow-private-benchmark`.
- Do not resume the paused 20-row candidate run.
