# Multi-track match validation idempotence design

## Status

Proposed from the immutable sparse-repair v2 live evidence on 2026-07-30.

## Confirmed failure

The fresh three-row run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v2-20260730`
completed its live process with two exact rows and one failed row. Zero-based
index `4` still failed at `matchJob` contract repair with initial and repair
reason `multi_track_requires_sparse`. Indices `9` and `10` were exact and
structurally complete. The 20-row root was not created, and the fixed candidate
was restored cleanly.

Static control-flow inspection establishes the product root cause:

1. The OpenAI-compatible adapter validates a sparse response.
2. `validateSparseMatchEvidence` derives the local full decision but discards
   the already validated `matches` and `eligibility` arrays.
3. `createLlmAnalyzer` and `cachedModelCall` validate the returned value again.
4. Without either sparse array, `validateModelResult` routes that normalized
   value through `validateMatchDecision`.
5. A multi-track context deliberately rejects that path with
   `multi-track matching requires sparse evidence`.

The repeated failure therefore does not prove that DeepSeek returned a legacy
shape. A valid sparse response becomes non-revalidatable at the first
normalization boundary.

## Constraints

- Keep every existing validation layer and the strict multi-track rule.
- Do not accept or convert an unvalidated legacy full decision.
- Do not add a model call or change DeepSeek thinking behavior.
- Do not expose raw model output, private evidence, or model configuration.
- Preserve single-track behavior and local decision derivation.
- Invalidate pre-fix match caches.

## Options

### Skip the analyzer or cache validation

This removes the immediate failure but weakens a defense-in-depth boundary and
makes injected/mock adapters behave differently. Reject.

### Add an internal trusted marker

A symbol or hidden flag could bypass later validation, but it creates a second
trust protocol and cannot survive JSON cache persistence. Reject.

### Retain validated sparse rows in the normalized decision

This is the recommended option.

`validateSparseMatchEvidence` already validates and normalizes `matches` and
`eligibility`. Return those two arrays with the derived local decision. On a
second validation, the ordinary sparse routing runs again and derives the same
decision. No validator is skipped, no legacy result becomes acceptable, and
the cached JSON remains self-validating.

The normalized object is an internal pipeline result, not the model response,
so retaining the validated sparse rows does not conflict with the model's
exact six-key output contract.

Increment `PIPELINE_VERSIONS.matchJob` from `match-decision-v28` to
`match-decision-v29` so no pre-fix normalized cache entry can be reused.

## Acceptance

- A focused test first proves RED by validating one legal multi-track sparse
  result, then validating the normalized result again.
- The first normalized result retains normalized `matches` and `eligibility`.
- The second result is deeply equal to the first.
- The synthetic raw sparse input includes an extra key with a privacy sentinel;
  neither the key nor the sentinel survives normalization or JSON cache
  round-trip.
- A JSON round-trip of the normalized result remains revalidatable.
- Single-track sparse results are also idempotent, while legacy single-track
  full decisions remain compatible.
- An injected adapter exercised through `createLlmAnalyzer` returns the same
  normalized multi-track result without a wrapper-level contract failure.
- A legacy multi-track full decision remains rejected.
- `PIPELINE_VERSIONS.matchJob` is exactly `match-decision-v29`, and a revision
  carrying v28 produces `match_pipeline_changed`.
- Existing adapter prompt/repair tests remain green.
- Semantic pipeline, model adapter, 31 benchmark fixtures, all offline checks,
  and diff check pass.
- Independent review reports no Critical, Important, or Moderate finding and
  concludes `Spec PASS` and `Code quality APPROVED`.
- Only then may a new three-row root be created. The sparse-repair v1/v2 roots
  remain immutable, and the 20-row root remains absent until all three rows
  pass.
