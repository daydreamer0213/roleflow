# Task 1 report: incoming contacts

## Result

Implemented and committed the read-only incoming-contact projection and its
funnel-page evidence view in code commit `6fc103e05ed2c904ea05deeadd9bf7873c38d932`.
It does not access a real platform or user database, write to user data, add a
storage-facade export, add dependencies, or change message sending.

## TDD evidence

### RED

1. `D:\hermes\node\node.exe tests\incoming_contacts_smoke.js`
   initially failed with `Cannot find module
   '../src/application/funnel_analysis/incoming_contacts'`.
2. After the aggregation test was green, the dashboard test initially failed
   because the returned HTML did not contain `收到的联系`.
3. The exported interface check initially failed with
   `TypeError: listIncomingContacts is not a function`; it then became a public
   export of `src/application/funnel_analysis`.
4. The explicit-text resume-request regression initially failed with
   `an explicit narrow text request counts as a resume request`.
5. The detail-link regression initially failed because all three platform
   numbers used the same `#incoming-boss-details` target.

### GREEN

Fresh final task-scoped command:

```powershell
$env:TEMP='D:\DevData\RoleFlow-tests'; $env:TMP='D:\DevData\RoleFlow-tests'
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
& 'D:\hermes\node\node.exe' tests\incoming_contacts_smoke.js
& 'D:\hermes\node\node.exe' tests\funnel_platform_feedback_smoke.js
& 'D:\hermes\node\node.exe' tests\dashboard_funnel_smoke.js
```

Output: `incoming_contacts_smoke: ok`,
`funnel_platform_feedback_smoke: ok`, and `dashboard_funnel_smoke: ok`.
The only output besides those success lines was Node's existing experimental
SQLite warning. `git diff --check` returned success before the code commit.

## Files

- `src/application/funnel_analysis/incoming_contacts.js` — all-records,
  read-only projection.
- `src/application/funnel_analysis/index.js` — public export and
  `dashboard.incomingContacts` projection.
- `src/dashboard/pages/funnel.js` — separates outgoing-contact feedback from
  received contacts and renders exact native-details drilldowns.
- `tests/incoming_contacts_smoke.js` — real SQLite persistence fixtures.
- `tests/dashboard_funnel_smoke.js` — dashboard HTML, exact deep link, details
  targets, and both table viewport checks.
- `tests/run_all.js` — registers the new smoke test.

## Interface and evidence boundary

`require('src/application/funnel_analysis').listIncomingContacts(db,
{ profileId })` returns items with:

`key`, `platform`, `conversationKey`, `cardId`, `jobId`, `title`, `company`,
`observedAt`, `resumeRequested`, `interviewInvited`, `inboundMessages`,
`messageIntent`, and `sourceKinds`.

`key` is a stable opaque value:

`sha256("incoming-contact-v1\0" + profileId + "\0" + platform + "\0" + conversationKey)`.

It is the exact value carried as `contact` in the safe deep link
`/messages?planId=…&source=boss|zhaopin&contact=<key>&task=all`.

Conversation identity is `(profileId, platform, conversationKey)`. The
projection reads all rows directly from the local tables (not the bounded 500
row context-list API), then merges linked contexts, reliably thread-bound
historical classifications, and unresolved items with safe inbound content.
It ignores blank unresolved loading items and never invents a conversation from
a historical card event without its own reliable thread key.

Resume requests are positive-only: an existing request card, explicit manual
request action, reliable `resume_requested` event, or a narrow full-sentence
affirmative request to send/provide a detailed or complete resume. The tests
cover a positive request plus “already received, do not send”, praise-only, and
bare-resume-reference negatives. Interview invitations remain limited to
reliable classification/event evidence; no body-text invitation guessing was
added.

`sourceKinds` describes stored evidence (`context`, `classification`,
`unresolved`), not user handling. There is deliberately no `processed` or
`handled` claim: Task 2 must use existing card stage/open-draft/manual-action
facts when it needs a user-action state.

## UI and compatibility

The outgoing-contact table now keeps only platform, contacted jobs, replies,
and reply share. “收到的联系” is a separate profile-wide section whose BOSS and
智联 rows remain fixed across current/lifetime switches. Its three count links
target distinct native-details lists for all contacts, resume requests, and
interview invitations. Every list item has the route key for Task 2; historical
records with cleared body content remain visible as reliable classifications.

## Independent review

Review package: `.superpowers/sdd/2026-09-10-incoming-opportunities-and-message-focus/task-1-review.md`.
The initial review raised two P1 items: linked text had to use the same narrow
resume-request rule, and each count needed an exact detail target. Both were
fixed, covered by regression tests, and re-reviewed as approved.

## Remaining boundary

Legacy progress events with no reliable card `thread_key` are intentionally
left only in the original active-contact history: assigning one to a new
incoming conversation would be a data-linkage guess. No real-data totals or
message text are recorded in this report.
