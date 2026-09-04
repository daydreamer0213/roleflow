# Final P2 Fix: focus-enable cleanup

## Scope

Moved each focus-emulation enable await inside its existing cleanup scope. If enabling fails, the existing disable call now still runs. The original enable error is preserved; reply fill/send do not insert text or click.

## RED

Environment for every command: `TEMP=D:\DevData\Temp`, `TMP=D:\DevData\Temp`, `NODE_OPTIONS=--disable-warning=ExperimentalWarning`; Node: `D:\hermes\node\node.exe`.

| Command | Result before production fix |
| --- | --- |
| `D:\hermes\node\node.exe tests/boss_communication_page_smoke.js` | FAIL (exit 1): focus-enable failure recorded only `enabled: true`; expected follow-up `enabled: false` at `tests/boss_communication_page_smoke.js:1177`. |
| `D:\hermes\node\node.exe tests/boss_message_reply_sender_smoke.js` | FAIL (exit 1): fill focus-enable failure recorded only `enabled: true`; expected follow-up `enabled: false` at `tests/boss_message_reply_sender_smoke.js:341`. |

## GREEN

| Command | Result after production fix |
| --- | --- |
| `D:\hermes\node\node.exe tests/boss_communication_page_smoke.js` | PASS (exit 0): `boss_communication_page_smoke ok`. |
| `D:\hermes\node\node.exe tests/boss_message_reply_sender_smoke.js` | PASS (exit 0): `boss_message_reply_sender_smoke ok`. |
| `D:\hermes\node\node.exe tests/browser_transport_smoke.js` | PASS (exit 0): `browser_transport_smoke ok`. |

## Regression coverage

- Communication dispatch: enable error remains the thrown error, disable runs, no click is issued, network and outcome-observer cleanup are reached.
- Reply fill: enable error remains the thrown error, disable runs, no text is inserted, and no click is issued.
- Reply send: enable error remains the thrown error, disable runs, no click is issued, and the prepared reply remains clearable rather than becoming dispatched.

No real BOSS page, profile, database, port, installed app, or external write was used.
