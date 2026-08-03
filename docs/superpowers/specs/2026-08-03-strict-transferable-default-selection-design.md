# Strict transferable-evidence default-selection design

Date: 2026-08-03
Status: draft for user review
Branch: `codex/strict-transferable-evidence`

## 1. Goal

Keep `transferable` as a profession-neutral explanation and recall signal, but
remove its ability to create an automatic communication selection by itself.

The change must:

- work for every profession without job-title, technology, platform, tool,
  model, or fixture-specific production rules;
- make Flash follow a short, deterministic evidence-state decision order;
- keep transferable opportunities visible in `caution` rather than deleting
  them from the result set;
- require affirmative direct evidence before a job enters `primary` or
  `apply`;
- apply to every supported model through one shared prompt and decision
  policy;
- remain isolated on the experimental branch until offline and live replay
  results are reviewed and explicitly approved for merge.

## 2. Evidence and intended trade-off

The paired batch-45 comparison used the same current product commit, the same
99 stored observations, and 52 identical model-input hashes.

Flash produced five default-selected jobs that the strict Pro run did not.
Manual evidence review classified the five as:

- one plausible transferable opportunity whose `primary` tier was too high;
- four unsafe automatic selections, including the known primary-delivery
  language pattern and three other cross-role or specialist-depth patterns.

The common failure was not one technology. Flash treated adjacent evidence as
positive proof of the required primary delivery work:

- a different implementation stack as proof of the required stack and
  business system;
- general automation as proof of named-platform production experience;
- application-layer AI work as proof of algorithm training and tuning;
- candidate evidence that explicitly stated an unproved difference as a
  positive transferable fact.

Under the proposed strict gate, all five current Flash-only defaults are
expected to move to `caution`. This intentionally sacrifices one plausible
automatic selection to remove four unsafe automatic selections. The job is not
discarded: it remains visible and reviewable in the caution queue.

This changes automatic-selection recall, not logical search or JD recall.
Before merge, the branch must report every demotion so the user can decide
whether the precision gain justifies the smaller automatic queue.

## 3. Existing behavior being superseded

The current recall-first policy treats both `matched` and `transferable` as
positive responsibility evidence. Its zero-duty-gap promotion route can floor
an otherwise cautious job to `apply` when every known primary duty is at least
transferable.

That behavior was intentionally introduced by the v4.4 and v4.5 evidence
promotion designs. This design does not erase those historical decisions. It
adds a later, stricter automatic-selection ceiling:

- promotion routes may continue to calculate diagnostic metrics;
- a job that fails the new direct-evidence gate is capped at `caution` after
  all promotion floors;
- safety ceilings always win over promotion floors.

## 4. Considered approaches

### 4.1 Add profession-specific prompt exceptions

Rejected. A growing list of languages, tools, platforms, industries, or job
titles would overfit the current candidate and weaken project generality.

### 4.2 Remove `transferable` from the model contract

Rejected. This would collapse a useful distinction between an adjacent,
reviewable opportunity and a completely unsupported one. It would reduce
explainability and remove a useful casebook and evaluation signal.

### 4.3 Keep `transferable`, but remove its automatic-selection vote

Selected.

- The model still records genuine adjacent capability.
- The caution queue preserves recall.
- Local code decides automatic-selection eligibility deterministically.
- The same rule works across software, operations, sales, accounting, design,
  manufacturing, healthcare, and other professions.

## 5. Evidence-state contract

The existing four states remain, with one ordered decision tree shared by all
models.

### 5.1 `matched`

Use only when one affirmative candidate fact proves the same primary work
object, main action, and deliverable required by the JD.

Named tools or domains may differ only when they do not define the required
primary work. The evidence must not claim that the required capability is
absent or unproved.

### 5.2 `transferable`

Use only when one affirmative candidate fact proves the same underlying main
action and deliverable, while the named context, tool, platform, framework, or
domain differs.

`transferable` is an adjacent-opportunity signal. It is not direct proof of
the required primary delivery experience and cannot by itself authorize
automatic selection.

### 5.3 `unknown`

Use when the candidate record does not prove the required work and does not
contain an explicit incompatible fact. `resumeEvidence` must be empty.

Absence, omission, or an unproved claim maps to `unknown`, not to a positive
state.

### 5.4 `missing`

Use only when an affirmative candidate fact proves an incompatible primary
work object, action, deliverable, or eligibility condition.

The model must not manufacture a negative resume statement from an omitted
skill or experience.

## 6. Prompt design

Do not append a long new paragraph to the existing prompts. Replace overlapping
state instructions with one compact ordered decision block in both split
matching prompts.

The block must:

1. ask whether an affirmative candidate fact proves the same primary work;
2. choose `matched` when it does;
3. otherwise choose `transferable` only when the same main action and
   deliverable are positively proved in another named context;
4. choose `unknown` with empty evidence when proof is absent;
5. choose `missing` only for an affirmative incompatible fact;
6. prohibit `matched` or `transferable` evidence whose own wording says the
   required capability is absent, omitted, unproved, or outside the candidate
   experience.

The prompt must remain profession-neutral. Tests must reject production prompt
text that contains current private job titles, technology-specific exceptions,
fixture identifiers, or model-specific branches.

No new model call, self-review call, voting step, top-level response key, or
model-specific prompt variant is added.

## 7. Contract validation

Positive responsibility and requirement states must contain a non-empty,
affirmative candidate fact.

Validation must reject a `matched` or `transferable` row when its candidate
evidence is framed as absence or non-proof, including the supported Chinese
and English equivalents of:

- not mentioned or not demonstrated;
- no experience or lacks experience;
- not used, not involved, or outside the demonstrated scope.

The validator must use bounded absence phrases rather than a catch-all
substring test. Affirmative phrases such as English `not only` and equivalent
non-absence constructions must remain valid. Focused tests must cover both
rejected absence statements and valid affirmative statements containing a
negation token.

The validation error must identify only the evidence kind and row ID. It must
not copy JD text, resume text, candidate identity, company, title, URL, model
response, or secrets into logs.

Existing one-shot contract repair remains responsible for converting the row
to:

- an affirmative `matched` or `transferable` fact;
- `unknown` with empty evidence; or
- `missing` with an affirmative incompatible fact.

The validator is a consistency boundary, not a profession-specific semantic
classifier.

## 8. Strict automatic-selection gate

The four-tier matrix remains responsible for the preliminary recommendation.
After existing promotion floors and safety ceilings, apply a final
direct-evidence ceiling.

A job is eligible to remain in `primary` or `apply` only when:

1. at least one selected-track primary responsibility is `matched` with bound
   JD and resume evidence;
2. every core requirement (`foundation`, `central`, or `indispensable`) is
   `matched` with bound JD and resume evidence;
3. semantic status and existing coverage, hard-blocker, quality, and safety
   gates already pass.

If either direct-evidence condition fails, cap the recommendation at
`caution`.

Consequences:

- all-transferable primary responsibilities are always `caution`;
- a transferable or unresolved core requirement is always `caution`;
- transferable supporting and soft requirements remain visible in the
  explanation but cannot promote or block a job whose direct gate otherwise
  passes;
- an explicit hard blocker or risk may still produce `not_recommended`;
- the strict gate never promotes a job.

## 9. Observability

Add privacy-safe decision metrics:

- `matchedPrimaryDutyCount`;
- `strictCoreTotalCount`;
- `strictCoreMatchedCount`;
- `strictCoreUnresolvedCount`;
- `strictDirectEvidenceReady`;
- `strictDirectEvidenceCeilingApplied`;
- `strictDirectEvidenceReason`, using stable enums only.

Suggested reasons:

- `no_matched_primary_duty`;
- `core_not_directly_matched`;
- `direct_evidence_ready`.

No evidence text or private source data may enter these metrics.

## 10. Versioning and cache safety

Advance:

- `matchJob` from `match-decision-v44` to `match-decision-v45`;
- `decisionRules` from `four-tier-weighted-v4.7` to
  `four-tier-weighted-v4.8`.

`understandJob`, recommendation schema, communication schema, provider
settings, selected model, temperature, and semantic split mode remain
unchanged.

Both version changes intentionally invalidate previous match and final-analysis
caches.

## 11. Test-first implementation

Add failing tests before production changes for:

1. all primary duties transferable and none matched caps `primary/apply` to
   `caution`;
2. one matched primary duty plus fully matched core evidence may remain
   `primary/apply`;
3. any transferable core requirement caps automatic selection to `caution`;
4. any unknown or missing core requirement caps automatic selection to
   `caution`;
5. transferable supporting or soft requirements do not block a job whose
   direct gate passes;
6. the strict ceiling overrides the existing zero-duty-gap and
   matched-indispensable promotion floors;
7. the strict gate never promotes a job or creates a hard blocker;
8. positive evidence framed as absence or non-proof fails contract validation;
9. contract repair can convert invalid positive evidence to `unknown` without
   adding private text to logs;
10. prompts share one profession-neutral decision block and contain no
    model-specific branch;
11. v44/v4.7 caches become stale under v45/v4.8;
12. generic fixtures cover at least three non-overlapping professions without
    production keyword exceptions;
13. intentional strict-policy expectation changes are documented and the
    complete updated offline suite passes.

## 12. Evaluation sequence

All model calls remain serial and isolated from the operational database.

### Stage 1: offline policy replay

Replay the saved batch-45 Pro and Flash analyses through v4.8 without calling
the model. Report:

- every tier transition;
- every default-selection transition;
- strict-ceiling reason counts;
- the five previously reviewed Flash-only defaults;
- any previously shared default that is demoted.

### Stage 2: targeted fresh-Flash diagnostic

Use fresh empty caches and the current confirmed profile/card for:

- the known Golang case;
- the four other reviewed Flash-only defaults;
- at least three controls that should remain outside automatic selection;
- at least two independently confirmed direct-evidence positive controls from
  the existing private 20-job fixture.

The private casebook case remains outside aggregate accuracy denominators.
If the frozen positive controls cannot be executed with the current confirmed
profile/card and product revision, Stage 2 is incomplete and Stage 3 must not
start until equivalent independently confirmed controls are approved.

### Stage 3: full batch-45 fresh-Flash replay

Run all 99 observations only after Stages 1 and 2 complete structurally.
Compare against the frozen current-Flash replay:

- structural completion;
- contract repair and failure counts;
- tier and default-selection changes;
- median and p95 latency;
- token usage and estimated cost;
- every disagreement involving `primary` or `apply`.

## 13. Acceptance and merge gate

The branch is eligible for merge only when:

- all offline tests pass;
- no profession- or model-specific production rule is introduced;
- model structure and contract failure rates do not regress materially;
- none of the four reviewed unsafe automatic selections remains in
  `primary/apply`;
- the known Golang case is not automatically selected;
- every new automatic selection has at least one matched primary duty and all
  core requirements directly matched;
- all demoted previously confirmed communication opportunities are shown to
  the user;
- the user explicitly approves the measured precision/automatic-recall
  trade-off.

The experimental branch must not merge itself, change the saved model, access
BOSS, create a communication batch, or send any communication.

## 14. Out of scope

- Job-title, language, tool, platform, industry, or model-name exceptions.
- Removing `transferable` from stored analysis or the review UI.
- Lowering search, detail-read, or JD coverage.
- Turning absence into a hard blocker.
- Changing the user profile, matching card, search plan, salary mode, or model
  setting.
- Automatically merging the branch after tests.
