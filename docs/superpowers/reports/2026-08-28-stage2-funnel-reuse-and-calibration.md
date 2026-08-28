# Stage Two Funnel Reuse and Calibration Report

Date: 2026-08-28

Decision: `reference_only`

## 1. Scope

This report answers two implementation questions for the approved job-search funnel design:

1. whether RoleFlow should add an analytics component or reuse its current SQLite/event architecture;
2. which current BOSS message-row fields were confirmed live before implementation.

The calibration is strictly read-only. It does not authorize sending, applying, filling, pasting, accepting or rejecting a résumé request, or changing browser focus.

## 2. Reuse Evaluation

### Existing SQLite and RoleFlow event history

RoleFlow already uses the built-in Node.js SQLite runtime, owns append-only candidate progress events, and has temporary-database smoke fixtures. SQLite supports ordinary aggregates and window functions with `PARTITION BY`, ordering, ranking, and framed calculations in the existing database engine ([official SQLite window-function documentation](https://www.sqlite.org/windowfunctions.html)).

This is sufficient for:

- one unique candidate/job funnel entry;
- per-entry maturity deadlines;
- unassigned mature-pool queries;
- atomic cohort freezing;
- grouped funnel counts and version comparisons;
- deterministic local tests.

No additional runtime, service, data copy, or license surface is required.

### DuckDB Node client

DuckDB is an embedded analytical database and its current Node Neo client is distributed as `@duckdb/node-api` plus lower-level bindings ([official Node client documentation](https://duckdb.org/docs/current/clients/node_neo/overview)). It could calculate the aggregates, but RoleFlow would need another database client, another storage/connection path, and synchronization from the authoritative SQLite event log.

For the current data volume, DuckDB removes no required RoleFlow code: maturity, provenance, unique ownership, and cohort freezing would still be product-specific. It is therefore not integrated.

### PostHog

PostHog is a broad product-analytics platform covering analytics, replay, flags, experiments, surveys, and data pipelines. Its main repository is MIT-licensed outside the separately licensed enterprise directory ([official repository license](https://github.com/PostHog/posthog/blob/master/LICENSE)).

RoleFlow would still need to define job ownership, 48-hour maturity, weekend adjustment, unknown-state handling, immutable cohort membership, and candidate privacy. Adding a general analytics platform would also create a second event destination for private job-search data. It is therefore not integrated.

## 3. Decision

`reference_only`

Use these established ideas only:

- append-only events;
- explicit event provenance;
- SQL grouping/partitioning;
- immutable cohort membership;
- separate waiting and unknown counts.

Keep the implementation in the current SQLite database and server-rendered Dashboard. Add no analytics dependency, ORM, remote service, chart framework, or background event pipeline.

## 4. Live Calibration Attempt

The complete `edge-browser-ops` instructions were read. They require `edge_bridge_status` as the first operation, followed by tab discovery from `edge_list_tabs`.

The current Codex task did not expose either Edge Control tool. A tool inventory check found neither command, so the required first operation could not be performed. Per the browser boundary, no alternative screen-control, foreground navigation, CDP guess, direct debug-port connection, click, or refresh was attempted.

Result:

```text
live_calibration: unavailable
reason: edge_control_tools_not_exposed
real_boss_access: none
clicks_or_writes: none
screenshot: none
```

This is a non-blocking evidence gap, not proof that the live DOM matches or differs from fixtures.

## 5. Current Code and Fixture Evidence

The current adapter and its passing offline fixtures support these row fields:

```text
rowIndex
unread
selected
conversationKey (safe digest)
previewDigest (safe digest)
previewKind
```

The supported preview kinds are:

```text
self_read
self_delivered
possible_hr_reply
platform_notice
unsupported
unknown
```

The adapter may read recruiter labels and preview text transiently to classify a row, but the funnel must never persist either value. It may persist only the safe conversation/message digest, classified preview kind, platform, and observation timestamp.

The fresh pre-implementation offline gate passed all 111 registered checks, including `boss_message_dom_smoke`, `boss_message_reader_smoke`, `message_preview_state_smoke`, `message_discovery_smoke`, and candidate-progress storage checks. These prove the current code/fixture contract only; they do not prove current live BOSS markup.

## 6. Implementation Consequences

- Do not change a BOSS selector or infer a new live field in stage two.
- Reuse the existing validated `scanConversationRows()` result; add no independent refresh.
- Treat unsupported, unknown, unbound, or unavailable fields as unknown, not failure.
- Keep positive message outcomes attributable to either a safe row observation or an existing classified progress event.
- Keep live calibration listed as unverified until Edge Control tools are available in a later authorized task.
- Do not make a current-platform claim from fixtures alone.
