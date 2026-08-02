# Deterministic Split Semantic Matching v4.7 Design

**Date:** 2026-08-02

## Context

The v4.6 product keeps the four recommendation tiers and the user-confirmed
70/30 weighted decision matrix in local code, but one model call still performs
track selection, responsibility matching, requirement matching, role alignment,
and an optional shadow recommendation together.

The fresh v4.6 three-row live run exposed two different failure modes:

- one expected `apply` row failed the combined `matchJob` contract twice;
- one expected `caution` row became `primary`.

Input and model-identity hashes proved that identical requests could produce
different semantic outputs at temperature zero. This ruled out product-input
drift as the primary cause.

An isolated split experiment then ran indices 5, 8, and 13 three times each:

- v1 preserved all output but failed six rows because otherwise valid evidence
  excerpts exceeded a 120-character boundary;
- v2 normalized non-empty evidence locally to 120 characters and completed all
  27 expected calls;
- v2 passed 9/9 structural checks and 9/9 default-communication behavior checks;
- v2 had zero expected-selection misses and zero false default selections;
- repeated `understandJob` outputs still varied, but the local four-tier result
  stayed stable.

This is evidence for a bounded extraction architecture, not evidence that the
model itself has become deterministic.

## External engineering references

The selected architecture follows common production boundaries:

- JSON mode guarantees parseable JSON, not complete business-schema adherence;
- a model should produce bounded semantic variables while application code
  validates and applies business rules;
- schema validation, immutable pipeline versions, evaluation fixtures, and
  fail-closed behavior are separate controls;
- strict provider-side schemas are useful when stable, but DeepSeek strict tool
  mode currently requires a beta endpoint and is not introduced here.

References:

- https://api-docs.deepseek.com/guides/json_mode
- https://api-docs.deepseek.com/guides/tool_calls
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/generativeaionvertexai-gemini-controlled-generation-response-schema-2
- https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-automated-reasoning-checks.html

## Goals

1. Replace the production OpenAI-compatible combined matching call with two
   narrow semantic calls:
   - selected-track responsibility evidence;
   - selected-track requirement and eligibility evidence.
2. Derive role alignment and the final four-tier recommendation in local code.
3. Preserve the existing four-tier matrix, weights, safety caps, and default
   batch-selection behavior unchanged.
4. Preserve a `legacy` adapter path as a bounded rollback option.
5. Keep private inputs and model configuration inside existing privacy gates.

## Non-goals

- Do not change any cell in the user-confirmed two-dimensional matrix.
- Do not tune the 70/30 requirement weights.
- Do not use repeated voting, majority selection, or model self-review.
- Do not switch the formal model configuration to a beta endpoint.
- Do not switch machine-readable output to Markdown.
- Do not add occupation-specific IT rules or examples.
- Do not access BOSS, cookies, port 8787, or `jobs.sqlite`.

## Architecture

### Pipeline modes

`semanticMatchingMode` accepts:

- `split`: the v4.7 default;
- `legacy`: the existing combined `matchJob` compatibility path.

This mode is a model-pipeline concern. It is deliberately not added to
`DECISION_POLICY`, so the decision-policy hash does not imply a matrix change.

The match cache version increments from `match-decision-v41` to
`match-decision-v42`. Old combined-call caches cannot be reused by the split
pipeline.

### Call sequence

For a live OpenAI-compatible analysis:

1. `understandJob` extracts hiring tracks, responsibility evidence,
   requirements, eligibility, and risk signals.
2. `matchResponsibilities` selects one existing track and returns only:

   ```json
   {
     "selectedTrackId": "T1",
     "matches": [
       {
         "id": "D1",
         "state": "matched",
         "resumeEvidence": "..."
       }
     ]
   }
   ```

3. Local code validates the selected track and responsibility IDs, rejects
   duplicate or invented IDs, fills omitted duties as `unknown`, and truncates
   non-empty evidence to 120 characters.
4. `matchRequirements` receives only the selected track, that track's
   requirements, eligibility items, and candidate facts. It returns:

   ```json
   {
     "matches": [
       {
         "id": "R1",
         "state": "matched",
         "resumeEvidence": "..."
       }
     ],
     "eligibility": []
   }
   ```

5. Local code applies the same ID, state, evidence, omission, and length rules.
6. Local code derives `roleAlignment` from responsibility states using the
   existing v4.6 responsibility thresholds.
7. The split rows are assembled into the existing sparse `matchJob` contract
   and passed through the existing cross-field validator.
8. Existing `applyRuleGuard` code computes weighted metrics, looks up the
   unchanged four-tier matrix, and applies safety ceilings.

### Model recommendation switch

The split pipeline forces `modelRecommendationMode = off`.

The model's holistic recommendation is not needed to compute the result and
would re-couple the two narrow tasks. The legacy path preserves the existing
`off`/`shadow` behavior for rollback and comparison.

### Deterministic normalization

Local normalization must:

- require exact top-level and item keys;
- reject unknown or duplicate D/R/E IDs;
- accept only canonical states;
- require non-empty evidence for returned sparse rows;
- truncate evidence to 120 characters instead of asking the model to retry for
  harmless verbosity;
- map omitted expected rows to `unknown`;
- never turn absence of evidence into `missing` or `conflict`;
- derive role alignment from canonical responsibility states only.

The normalizer must not add candidate facts or infer a stronger state.

### Failure handling

The existing single bounded contract-repair path remains available for a true
invalid split result. There is no self-review or voting loop.

If either split call remains invalid after the bounded repair, the analysis
fails closed as `analysis_pending`; it does not enter a recommendation tier or
default communication.

## Testing

### Focused TDD

Add offline tests proving:

- `split` causes exactly two matching calls;
- each call receives only its task-specific contract;
- overlong non-empty evidence is truncated locally;
- omitted rows become `unknown`;
- unknown and duplicate IDs fail;
- local role alignment is deterministic;
- split mode disables the shadow recommendation;
- `legacy` retains the existing combined prompt behavior;
- the job runner defaults to `split`;
- the match pipeline version is `match-decision-v42`.

### Offline regression

Run:

- focused adapter and semantic tests;
- 31 generic benchmark fixtures;
- private full-chain runner smoke;
- `npm.cmd test`;
- `git diff --check`.

### Live acceptance

Use immutable new private roots and fresh caches:

1. Run the established three diagnostic indices first.
2. Report the result in Chinese with English fields annotated.
3. Continue to 20 rows only when all three are structurally complete and:
   - all expected `primary`/`apply` rows are selected;
   - no expected `caution`/`not_recommended` row is selected.
4. For the 20-row run, require the same behavior boundary. Exact four-tier
   equality is diagnostic, not the acceptance target.

Any severe false default selection stops at its first row for root-cause work.

## Rollback

Set `semanticMatchingMode` to `legacy` and invalidate the current analysis
revision. Do not change the matrix or reinterpret existing labels during
rollback.

