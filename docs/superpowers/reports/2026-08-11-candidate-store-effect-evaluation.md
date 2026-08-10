# Candidate store extraction effect evaluation

Baseline: `e9994b744a27a8eb60509191ad6a1a7fb4403f30`.

## Measurement method

The source totals cover every `*.js` file below `src`, counted file-by-file with Node and excluding a terminal newline as a separate line. Facade baseline values use the frozen brief's baseline and the same nonblank-line rule.

| Measure | Baseline | After | Change |
| --- | ---: | ---: | ---: |
| `src/core/storage.js` physical lines | 5,030 | 4,549 | -481 |
| `src/core/storage.js` nonblank lines | 4,770 | 4,292 | -478 |
| all `src/**/*.js` physical lines | 34,464 | 34,566 | +102 |
| all `src/**/*.js` nonblank lines | 32,455 | 32,519 | +64 |
| `src/**/*.js` files | 86 | 88 | +2 |

The line movement is not the acceptance criterion. The ownership and executable contract checks below are the acceptance evidence.

## Ownership and compatibility evidence

- `Object.keys(require("./src/core/storage"))` is exactly the frozen 136-key set.
- `candidate_store.js` exports exactly 29 operations; every one has `facade[name] === candidateStore[name]`.
- A declaration scan finds all 29 operation bodies and the nine candidate-only helpers only in `src/storage/candidate_store.js`; none remains in the facade.
- `src/storage/storage_shared.js` exports only the unchanged `nowIso` and `parseJson` primitives.
- `candidate_store.js` imports only Node `crypto`, `./storage_shared`, and `../core/matching_card`; it does not import the facade, an opener, HTTP/dashboard/CLI, BOSS, or browser code. The new contract loads direct store plus facade without a circular-dependency warning.

## Executable behavior evidence

`node tests/candidate_store_contract_smoke.js` uses `openDb(":memory:")` and verifies the following real SQLite behavior:

- profile/document/version/plan list and row shapes; document reads omit resume text;
- JSON fallbacks, 6,000-character excerpts, document/manual version keys, draft exclusion and later matching inclusion;
- idempotent card drafts, draft edits, confirmation no-op, superseding, confirmed revisions, matching context;
- fact key normalization/upsert and 2,000-character value cap;
- job (`getOutcomeAnalyticsSnapshot`) and workflow (`getWorkflowHealthSnapshot`) readers consume candidate plans through the facade;
- forced late `saveProfileAnalysis` failure leaves profile, document, profile-version, resume-version, and plan counts unchanged;
- forced circular `saveSearchPlan` JSON serialization leaves the prior plan inactive, preserving the intentional non-transaction partial state.

The same fixture records transaction calls: `saveProfileAnalysis`, `saveCandidateResumeVersion`, and `updateCandidateProfile` emit `BEGIN` then `COMMIT`; `confirmMatchingCard` and `saveConfirmedMatchingCardRevision` emit `BEGIN IMMEDIATE` then `COMMIT`; the forced profile failure emits `BEGIN` then `ROLLBACK`.

## Regression evidence

Focused offline commands passed:

- `node tests/candidate_store_contract_smoke.js` — 0.161 s in the focused run.
- `node tests/onboarding_smoke.js` — 4.106 s.
- `node tests/matching_card_smoke.js` — 0.113 s.
- `node tests/analysis_application_smoke.js` — 1.272 s.
- `node tests/communication_smoke.js` — 0.753 s.
- `node tests/data_visibility_smoke.js` — 3.611 s.
- `node tests/workflow_application_smoke.js` — 0.075 s.
- `node tests/workflow_health_smoke.js` — 0.225 s.
- `node tests/storage_migration_smoke.js` — 1.028 s.

`node tests/run_all.js` passed all 85 offline checks in 128.919 s. These tests use fixtures/temporary or in-memory SQLite databases; no production database, live model, browser page, network request, or communication action was used for this task.

## Remaining coupling and next safe step

`storage.js` intentionally retains schema/migrations, `openDb`, transaction primitives, health, job, scan, workflow, and communication-backfill ownership. Job-owned cross-table operations still read candidate data through the facade. The next safe task is the separately scoped job-store extraction, preserving those cross-table transaction boundaries and continuing to consume candidate operations through direct facade references.
