# Multi-track sparse repair design

## Status

Proposed from the immutable reason-v5 live evidence on 2026-07-30.

## Confirmed failure

The frozen zero-based index `4` failed both the initial `matchJob` contract
validation and its single repair with:

- category: `result_shape`
- reason: `multi_track_requires_sparse`
- understandJob repair count: `0`
- matchJob repair count: `1`

The output triggered the validator rule that a multi-track match must return
sparse evidence rows. The raw shape was not persisted or inspected. Because
the repair input carries the invalid output, legacy-shape anchoring is a
product-fix hypothesis to verify with TDD rather than a claimed raw fact. The
strict validator is behaving as designed.

## Constraints

- Do not weaken or bypass the multi-track sparse validator.
- Do not mechanically accept a legacy full decision as sparse evidence.
- Do not reduce JD coverage, recall, or evidence requirements.
- Keep the one-repair limit and existing cache/provenance behavior.
- Preserve all non-sparse contract repair behavior.
- Do not change the current DeepSeek thinking A/B policy without separate
  evidence. The v5 initial non-thinking call and default-thinking repair both
  produced the same strict sparse-validator failure.

## Options

### Prompt-only reinforcement

Add stronger exact-key wording to the match prompt.

This helps the initial call but leaves the repair anchored on a legacy
`invalidOutput`, so it is not sufficient by itself.

### Accept or locally convert the legacy full decision

This could avoid another model failure, but labels in a full decision are not
stable sparse IDs and may contain evidence from the wrong hiring track. It
would weaken the validator and create a branch-leakage risk. Reject.

### Exact-key prompt plus targeted repair de-anchoring

This is the recommended option.

1. State that the match response must contain exactly these six top-level keys:
   `selectedTrackId`, `roleAlignment`, `roleResumeEvidence`, `roleGaps`,
   `matches`, and `eligibility`.
2. Explicitly forbid legacy local-decision keys such as `recommendation`,
   `fitLevel`, `confidence`, `fitReasons`, `requirementMatches`, `jobQuality`,
   `hardBlockers`, `softGaps`, `questionsToVerify`, and `evidence`.
3. When and only when the trimmed contract repair reason exactly equals the
   complete validator-owned message
   `matchJob 模型输出不符合契约：multi-track matching requires sparse evidence`,
   create a new model input without `contractRepair.invalidOutput`. Prefixes,
   suffixes, mixed errors, and near matches must keep the existing repair
   input unchanged. Replace the generic repair instruction with a fixed
   instruction to rebuild the exact six-key sparse object from the original
   candidate and `jobUnderstanding` inputs.
4. Do not mutate the caller's input. Preserve all other fields and all other
   repair paths unchanged.
5. Validate the rebuilt response through the existing strict validator.

Removing the invalid legacy object is safe because the original candidate
profile, matching card, preferences, and job understanding remain in the same
request. The model recomputes evidence from authoritative inputs instead of
copying a structurally invalid decision.

## Privacy and safety

- No private value is logged or added to diagnostics.
- The fixed reason check uses only a validator-owned literal.
- The replacement instruction contains no job, resume, model, or config data.
- The discarded `invalidOutput` remains inside the existing in-process repair
  call and is not persisted by this change.

## Acceptance

- A focused adapter test first fails because sparse repair still forwards
  `invalidOutput` and the prompt lacks the exact-key contract.
- The prompt test proves the six allowed keys and the legacy-key prohibition.
- A sparse-repair test proves `invalidOutput` is absent from the model input,
  the original input is unchanged, and the fixed rebuild instruction is
  present.
- An exact message padded only with leading/trailing whitespace still triggers
  the targeted repair preparation.
- Mixed, non-whitespace-prefixed/suffixed, and near-match reasons prove
  `invalidOutput` is preserved and the generic instruction is unchanged.
- A non-sparse repair test proves existing repair input remains unchanged.
- Existing match validation tests continue to reject legacy multi-track
  decisions.
- Candidate offline checks and independent review pass before any new live
  run.
