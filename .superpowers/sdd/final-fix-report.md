# Final Fix Report

## Scope

This fix addresses the final review findings for read-only BOSS message discovery. No live browser, BOSS session, or production database was used.

## Root Causes And Fixes

1. The post-click reader compared the selected row's transient signature directly. Opening a conversation changes only `unread` from true to false, which made a correct selection look drifted. The reader now recomputes the selected signature with `unread: true`, while retaining the row index, recruiter label, and preview text checks. A selected snapshot also requires at least one message with a valid message id before success.
2. The message-discovery API serializer reused the draft-bearing result sanitizer. JSON status and start/stop/dismiss responses now use an explicit safe-field whitelist without `messages`; the server-only page renderer reads the bounded in-memory draft results separately.
3. Model instructions alone allowed historical sensitive facts to influence replies. The common `createLlmAnalyzer` output boundary now converts GAP, leaving-reason, and short-project explanation requests into `needs_user_action` with no draft and a current-confirmation fact. Existing safe missing-fact results are preserved. Availability and interview-invitation behavior remains unchanged.

## TDD Evidence

- RED: `tests/boss_message_reader_smoke.js` failed with `BOSS_MESSAGE_TARGET_MISMATCH` for a selected row made read after click.
- RED: `tests/dashboard_message_discovery_smoke.js` failed the explicit JSON whitelist assertion because `messages` was present.
- RED: `tests/message_discovery_smoke.js` received `reply_ready` instead of `needs_user_action` for a historical sensitive fact.
- GREEN: all required offline smoke tests listed below passed after the minimal fixes.

## Final Offline Verification

`NODE_PATH` was set to `D:\DevData\RoleFlow-codex-deps\candidate-progress-manual-reply\node_modules`.

- `node tests/boss_message_reader_smoke.js`
- `node tests/dashboard_message_discovery_smoke.js`
- `node tests/message_discovery_smoke.js`
- `node tests/communication_smoke.js`
- `node tests/semantic_pipeline_smoke.js`
- `node tests/data_visibility_smoke.js`
- `node tests/dashboard_communication_batch_smoke.js`

All seven commands passed. Node emitted only its experimental SQLite warning during temporary offline database tests.
