# CDP Internal Target Filter Design

## Goal

Keep RoleFlow's portable Edge browser usable when Edge exposes an internal
page target that has no browser-window identity, without weakening the
same-window safety checks for BOSS tabs.

## Observed failure

During the approved live-read preflight, CDP exposed these targets:

- the BOSS search page, with a valid `windowId`;
- the fixed `BOSS-COMMUNICATION` `about:blank` tab, with the same valid
  `windowId`;
- `edge://nurturing/`, whose `Browser.getWindowForTarget` call failed with
  `Browser window not found`.

`CdpBrowserAdapter.listTabs()` currently requests a window identity for every
`type === "page"` target. One windowless Edge-internal target therefore makes
the entire tab inventory fail, even though the two BOSS operation tabs are
valid and remain in the same window.

## Chosen design

`CdpBrowserAdapter.listTabs()` will evaluate each page target independently.

1. A target with a valid `windowId` remains in the returned tab inventory.
2. A target is skipped only when both conditions hold:
   - its URL is an internal, non-web scheme such as `edge:`; and
   - resolving its window identity reports the specific no-window condition.
3. A missing window identity for `http:` or `https:` targets, including every
   BOSS page, remains a hard `BROWSER_COMMAND_FAILED` error.
4. `about:blank` is not treated as an internal target for this rule. The fixed
   communication tab must still have a verifiable `windowId`.

No browser creation, navigation, click, pacing, BOSS selector, or communication
behavior changes as part of this fix.

## Alternatives considered

- Hard-code `edge://nurturing/`: rejected because Edge may expose other
  windowless internal promotion targets over time.
- Ignore every failed `Browser.getWindowForTarget` call: rejected because it
  could hide a lost or cross-window BOSS tab.
- Bypass the adapter only for this live acceptance: rejected because it leaves
  the product transport failure in place.

## Tests and acceptance

Add focused transport coverage proving that:

- a BOSS search tab and `about:blank` communication tab with valid identities
  are returned when a windowless `edge:` target is also present;
- a missing identity on an `https:` BOSS target still fails closed;
- a missing identity on `about:blank` still fails closed.

Run `node tests/browser_transport_smoke.js` and the related browser readiness
smoke test. Then repeat the live tab inventory before resuming the approved
5-10 JD, serial, read-only acceptance. No communication or application action
is authorized.
