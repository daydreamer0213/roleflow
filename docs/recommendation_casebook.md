# Recommendation error casebook

Human-confirmed recommendation errors are retained in the private local
casebook at:

`D:\DevData\RoleFlow-private-benchmark\recommendation-casebook`

Real jobs, URLs, companies, model outputs, and candidate evidence must not be
committed to this repository.

## When to add a case

Add a case only after the user explicitly confirms that a recommendation or
default selection is wrong. Search `index.jsonl` first and update an existing
case when the source hash and failure signature already exist.

## Required records

- one JSONL index row;
- one readable Markdown diagnosis under `cases`;
- one private JSON snapshot under `snapshots`;
- observed and expected tiers;
- the evidence-to-decision error chain;
- privacy-minimized candidate capability states;
- model, pipeline, and decision-policy versions;
- status `open`, `resolved`, or `converted_to_fixture`.

Private cases are optimization evidence, not production rules. A case may
become a committed regression fixture only after it has been separately
sanitized or replaced with synthetic data.
