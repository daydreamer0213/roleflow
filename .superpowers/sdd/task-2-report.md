# Task 2 Report: Single-Tab Read-Only Guarded Reader

## Scope

Implemented the Task 2 code and test registration files:

- `src/adapters/sites/boss_message_reader.js`
- `tests/boss_message_reader_smoke.js`
- `tests/run_all.js`

This report is the explicitly requested Task 2 artifact. No real browser, BOSS page, chat, or database was accessed.

## TDD evidence

### RED

Command:

```powershell
node tests/boss_message_reader_smoke.js
```

Output:

```text
Error: Cannot find module '../src/adapters/sites/boss_message_reader'
Require stack:
- ...\\tests\\boss_message_reader_smoke.js
```

This is the expected missing-module failure before production implementation.

### GREEN

Command:

```powershell
node tests/boss_message_reader_smoke.js
```

Output:

```text
boss_message_reader_smoke ok
```

The test covers one fixed chat tab, a frozen queue with immutable `tabId` targets, guarded success, zero/two-tab stop conditions, expression rechecks, row drift, disappearing unread badge, selected-target mismatch, risk/login/page loss stopping, abort-before-click, and forbidden browser methods.

## Regression commands

Requested command attempted:

```powershell
node tests/boss_message_reader_smoke.js
node tests/boss_communication_action_smoke.js
node tests/communication_calibration_gate_smoke.js
```

Observed output:

```text
boss_message_reader_smoke ok
Error: Cannot find module '...\\tests\\boss_communication_action_smoke.js'
```

The requested `boss_communication_action_smoke.js` does not exist in this worktree. The registered existing communication page regression was run instead:

```powershell
node tests/boss_message_reader_smoke.js
node tests/boss_communication_page_smoke.js
node tests/communication_calibration_gate_smoke.js
```

Observed output:

```text
boss_message_reader_smoke ok
boss_communication_page_smoke ok
Error: Cannot find module 'pdf-parse'
Require stack:
- ...\\src\\core\\resume_parser.js
- ...\\src\\dashboard\\server.js
- ...\\tests\\communication_calibration_gate_smoke.js
```

The calibration-gate test was blocked before it exercised its target code by the pre-existing missing `pdf-parse` dependency. No dependency installation was performed.

## Self-review

- `scanUnread()` uses only `listTabs` and `evalValue`, accepts exactly one `/web/geek/chat` tab, and does not mutate Task1 queue entries.
- The guarded expression synchronously rechecks path, snapshot helper, risk, login, target row index, Task1-compatible transient signature, unread badge, connection, and clickability before its sole `.friend-content-warp.click()`.
- The guarded expression contains no asynchronous boundary and never queries or clicks chat input, send controls, links, buttons, or other rows.
- Guard failures map to fixed local error codes; browser-supplied text is never included.
- After a guarded click, independent snapshots require exactly one selected matching row, non-empty header and position, and valid `data-mid`-compatible message IDs.
- No existing communication implementation was changed.

## Commit

`e9d006b3a168e144bc66d0f9692c01a16d546b25` - `feat: guard read-only message selection`

## Review-fix follow-up

### RED

Command:

```powershell
node tests/boss_message_reader_smoke.js
```

Output before the fix:

```text
AssertionError: expected { clicked: false, reason: 'row_drifted' }
but received { clicked: true, rowIndex: 0 }
```

The new offline VM test supplied a snapshot helper that falsely reported the target signature while the actual `.friend-content-warp` text had changed. The previous guard clicked, proving it incorrectly trusted the helper row signature.

### GREEN

Command:

```powershell
node tests/boss_message_reader_smoke.js
```

Output:

```text
boss_message_reader_smoke ok
```

The fixed expression reads the current target row DOM, applies Task1's line normalization and canonicalization, computes synchronous SHA-256, and compares it with the frozen target signature before its only click. The added tests also prove reader mutual exclusion and reject copied, unknown-tab, and previous-scan target objects with `BOSS_MESSAGE_TARGET_INVALID` and zero clicks.

### Follow-up regression results

```powershell
node tests/boss_communication_page_smoke.js
```

```text
boss_communication_page_smoke ok
```

```powershell
$env:NODE_PATH = (npm.cmd root -g).Trim()
node tests/communication_calibration_gate_smoke.js
```

```text
NODE_PATH=D:\\hermes\\node\\node_modules
Error: Cannot find module 'pdf-parse'
```

The calibration-gate test is blocked before test execution because the established Node module path does not contain `pdf-parse`. No dependency was installed.

### Follow-up self-review

- The guard uses `window.__bossMessageSnapshot()` only for path-risk-login state; it does not use the helper's row signature to authorize a click.
- The only authorization signature is synchronously recomputed from the current indexed target row's first and last visible lines, row index, and current `.notice-badge` state.
- `openingConversation` is released in `finally`; a second open during the first returns `BOSS_MESSAGE_READER_BUSY` before any browser evaluation or click.
- The active `Set` is replaced after each scan; only its exact frozen target objects and its exact tab id are accepted.
- Post-click selected/header/position/message-id verification remains unchanged.

### Follow-up commit

`b88097501077edf700511a7db9afc89337af4a18` - `fix: harden guarded message reader`
