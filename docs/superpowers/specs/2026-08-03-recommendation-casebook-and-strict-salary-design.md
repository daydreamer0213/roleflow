# Recommendation Casebook and Strict Salary Design

## Purpose

RoleFlow needs a durable place to retain human-confirmed recommendation errors
without immediately converting a single observation into a production rule.
The first case is a Golang backend role that was classified as `apply` and
default-selected even though the candidate had no direct Golang evidence.

The user also confirmed that strict salary handling should become the default
and should apply to the current saved search plan.

Execution-time note: before Task 2, a read-only preflight found that the stale
batch precondition no longer matched reality. The user chose to preserve the
actual completed communication-batch state and continue the strict-salary work.

## Goals

- Preserve real recommendation-error evidence outside Git and outside the
  operational jobs database.
- Make cases readable by a person and searchable by future tooling.
- Provide a repeatable process for adding similar human-confirmed cases.
- Keep private job and candidate evidence out of repository history.
- Change new search plans and the current saved plan to strict salary handling.

## Non-goals

- Do not change the language-matching or recommendation policy yet.
- Do not automatically train, prompt, or rescore from one case.
- Do not add the real case to committed test fixtures.
- Do not modify the already completed communication batch.
- Do not store candidate names, contact details, or full resume content.

## Storage layout

Private data lives under:

`D:\DevData\RoleFlow-private-benchmark\recommendation-casebook`

The directory contains:

```text
recommendation-casebook/
├── README.md
├── index.jsonl
├── cases/
│   └── REC-20260803-001-golang-ai-backend.md
└── snapshots/
    └── REC-20260803-001.json
```

The repository contains only a privacy-safe usage guide at
`docs/recommendation_casebook.md`. It documents the private location, schema,
addition workflow, and privacy boundary, but contains no real job or candidate
content.

## Case structure

Each index row contains:

- schema version and stable case ID;
- creation time and status;
- error category and concise title;
- source site plus a one-way source identity hash;
- observed tier and expected tier;
- whether the incorrect result entered default selection;
- model, pipeline, and decision-policy versions;
- relative paths to the readable case and private snapshot;
- tags for later grouping.

Each readable case records:

- the job snapshot and relevant JD evidence;
- the system recommendation and default-selection outcome;
- the human-confirmed expected behavior;
- the full evidence-to-decision error chain;
- root-cause classification;
- similar scenarios to watch for;
- possible future optimization directions;
- resolution history when a later change addresses the case.

The private JSON snapshot retains the exact job and analysis fields needed to
reproduce the diagnosis. Candidate evidence is minimized to capability states,
such as “no direct Golang evidence”; identity and full resume text are excluded.

## First case

The initial case receives the ID `REC-20260803-001` and category
`primary_delivery_language_misclassified`.

Its confirmed expected outcome is `caution`, outside default selection. The
case records that the selected AI application track and four matched AI
requirements outweighed a missing Golang requirement because the language was
classified as supporting rather than foundation, central, or indispensable.

This case is evidence for future investigation, not authorization to implement
a language-specific guard.

## Addition workflow

1. A user explicitly confirms that a recommendation is wrong.
2. Search `index.jsonl` for the source hash and equivalent failure signature.
3. Update an existing case when it is the same observation; otherwise allocate
   the next case ID.
4. Write the private JSON snapshot and readable Markdown case.
5. Append one JSONL index row only after both case files are valid.
6. Verify that no candidate identity, contact detail, secret, cookie, or full
   resume text is present.
7. Keep the case `open` until a later optimization is independently designed,
   tested, and evaluated.

If a case becomes a regression fixture, create a separate synthetic or
sanitized fixture in the repository. Never copy the private snapshot directly
into Git.

## Strict salary behavior

`PRODUCT_POLICY.searchPlan.defaultSalaryMode` changes from `wide` to `strict`.
Plan normalization therefore uses strict mode when no explicit mode is
provided. The dashboard continues to allow an explicit user choice.

The current saved search plan is migrated from `wide` to `strict` through the
normal storage/API path. Existing scan history and communication batch #5 are
unchanged. Future rescoring or scans may exclude roles whose maximum salary is
below the configured 9K lower bound.

Current-data impact measured before the change:

- 14 of 103 jobs have a maximum salary below 9K;
- only one of the original nine default-selected jobs is affected;
- none of the seven jobs in completed communication batch #5 is affected.

## Validation

- A focused test first proves that a plan without `salaryMode` currently
  normalizes to `wide`.
- After the policy change, the same test must expect `strict`; an explicitly
  supplied `wide` plan must remain `wide`.
- Dashboard rendering must show strict selected for a strict current plan.
- The current database must report `salaryMode: strict` for plan #1.
- Communication batch #5 must retain the same seven job IDs, have status
  `completed`, have all items `succeeded`, and have click count `1` for every
  item.
- The casebook index must parse as JSONL; referenced files must exist and use
  the declared case ID.
- A privacy scan must reject candidate names, contact details, secrets, cookies,
  and full resume text from the new casebook files.

## Failure handling

- If the private directory cannot be created, stop without changing the current
  search plan.
- If any case file fails validation, do not append its index row.
- If the current plan update fails, leave the product default change unclaimed
  and report the exact error.
- No BOSS navigation or communication action is part of this work.
