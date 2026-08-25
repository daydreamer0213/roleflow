# Portable CDP Communication Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dedicated Edge CDP adapter the bounded network-observation contract required by the already accepted communication verifier, and fail before any batch/session/item mutation when that contract is unavailable.

**Architecture:** Add an explicit communication-capability preflight at the CLI boundary. Implement one persistent, per-tab CDP `Network` observer behind `CdpBrowserAdapter` with the same four methods exposed by Edge Control. The observer records only allowlisted XHR/fetch endpoint evidence in memory, bounds entries and response bodies, and is stopped in every exit path. Existing site and executor logic remains browser-agnostic and keeps the conservative click ledger.

**Tech Stack:** Node.js 22 CommonJS, native WebSocket/CDP, existing BOSS site adapter and communication executor, assert-based fake-WebSocket smoke tests.

## Global Constraints

- This plan does not authorize a real BOSS communication. All implementation checks are offline.
- Do not resume or replay the interrupted historical batch. Its ambiguous ledger entry remains evidence.
- Preserve serial execution, exact immutable-batch authorization, immediate stop signals, identity recheck, one-click boundary, and no automatic retry after ambiguity.
- Network observation must not collect request bodies, cookies, authorization headers, chat content, arbitrary endpoints, raw query strings, or unrestricted response bodies.
- Browser activity remains background-only; do not add `Page.bringToFront` or focus recovery.
- Keep Edge Control compatibility, but do not make it a required ordinary-user installation dependency.

---

### Task 1: Fail capability preflight before communication state changes

**Files:**
- Modify: `tests/communication_cli_authority_smoke.js`
- Modify: `src/cli.js`

**Interfaces:**

```js
assertCommunicationBrowserCapabilities(browser)
```

Required methods include the existing tab/DOM/input operations plus:

```text
startNetworkLog
getNetworkLogMark
readNetworkLog
stopNetworkLog
```

Failure code: `BOSS_COMMUNICATION_BROWSER_CAPABILITY_MISSING`, with only missing method names in public diagnostics.

- [ ] **Step 1: Write a failing no-mutation preflight test**

Inject a portable browser lacking the four network methods. Assert `communicate()` fails with the typed capability error before binding lifecycle begins, before a communication session starts, before batch status or item state changes, and before `clickAt()`.

- [ ] **Step 2: Tighten the success fixture**

Add explicit no-op network methods to the portable success fake so tests no longer pass with an unrealistically capable site mock hiding an incomplete browser adapter.

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `node tests/communication_cli_authority_smoke.js`

Expected: FAIL because the current CLI reaches execution without checking the adapter contract.

- [ ] **Step 4: Implement the capability assertion at the earliest safe boundary**

Call it immediately after creating/selecting the browser implementation and before tab binding, runtime reconciliation, session creation, or persistent communication state mutation. Keep the method list in one constant/helper rather than scattering `typeof` checks.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `node tests/communication_cli_authority_smoke.js`

Expected: PASS.

### Task 2: Implement a bounded persistent CDP Network observer

**Files:**
- Create: `src/adapters/browser/cdp_network_log.js`
- Modify: `src/adapters/browser/cdp.js`
- Modify: `tests/browser_transport_smoke.js`

**Interfaces:**

`CdpBrowserAdapter` must expose the same public signatures used by `BossSiteAdapter`:

```js
startNetworkLog(tabId, options)
getNetworkLogMark(tabId)
readNetworkLog(tabId, options)
stopNetworkLog(tabId)
```

The internal observer owns a single target WebSocket and handles command responses plus these CDP events:

```text
Network.requestWillBeSent
Network.responseReceived
Network.loadingFinished
Network.loadingFailed
```

- [ ] **Step 1: Write a failing adapter-contract test**

Instantiate the real `CdpBrowserAdapter` with the fake global WebSocket already used by `browser_transport_smoke.js`. Assert all four methods exist and `startNetworkLog()` sends `Network.enable` on the selected target socket.

- [ ] **Step 2: Write failing success/failure event tests**

Feed an allowlisted Fetch/XHR request, response, and loading-finished sequence; assert a monotonically sequenced sanitized entry is returned after the mark. Also cover HTTP failure, `loadingFailed`, no matching request, and duplicate/late events.

- [ ] **Step 3: Write failing privacy and bound tests**

Assert non-allowlisted host/path events are never retained. For retained entries, the adapter may return a bounded `content` field to the in-process BOSS classifier, but must strip query parameters and must never return request post data, headers, cookies, or any body beyond `maxBodyBytes`. Cover `maxEntries`, `maxBodies`, and `maxBodyBytes`, and prove that the later persisted outcome contains only the sanitized business classification rather than `content`.

- [ ] **Step 4: Write failing cleanup tests**

Assert normal stop sends `Network.disable` and closes the socket. Assert target loss, browser disconnect, start replacement, and a thrown body-read command leave no observer in the adapter map.

- [ ] **Step 5: Run the focused transport test and confirm RED**

Run: `node tests/browser_transport_smoke.js`

Expected: FAIL because `CdpBrowserAdapter` has no network-log contract.

- [ ] **Step 6: Implement the minimal observer**

Use one command-ID counter and pending-command map on the persistent socket. Filter URL and resource type before allocating an entry. Store only a normalized allowlisted endpoint URL without query text. Request a response body only for an allowlisted completed response and only while body limits permit it. The bounded body may cross the adapter/site boundary in memory because the existing classifier derives the BOSS business code there; it must never cross the outcome-sanitization/storage boundary.

- [ ] **Step 7: Delegate from `CdpBrowserAdapter`**

Keep a `Map` keyed by numeric tab ID. Starting a new observer for a tab first stops the old one. `getNetworkLogMark()` and `readNetworkLog()` require the active matching observer. `stopNetworkLog()` is idempotent and removes the map entry in `finally`.

- [ ] **Step 8: Run the focused transport test and confirm GREEN**

Run: `node tests/browser_transport_smoke.js`

Expected: PASS.

### Task 3: Prove the site adapter never crosses the click boundary without observation

**Files:**
- Modify: `tests/boss_communication_page_smoke.js`
- Modify: `tests/communication_executor_smoke.js`
- Modify: `src/adapters/sites/boss.js`
- Modify: `src/core/communication_executor.js`

**Interfaces:**
- Add an adapter preparation step, `prepareCommunicationDispatch(inspection, signal)`, that completes stable readiness checks and starts network observation without clicking.
- Network observation must be successfully started before the executor records/enters its one-way click boundary.
- Every success, known failure, stop signal, and thrown error must call `stopNetworkLog()`.
- The persisted result remains sanitized endpoint/status/business-code evidence only.

- [ ] **Step 1: Write a failing observer-start test**

Make `startNetworkLog()` throw from `prepareCommunicationDispatch()`. Assert `clickAt()` is zero, no click-result verifier runs, and the item transitions from `verified` to the safe non-clicked `stopped` state rather than `click_dispatched`/`ambiguous`.

- [ ] **Step 2: Write cleanup-path tests**

Cover successful verified communication, HTTP/business failure, no matching request, target mismatch, and thrown DOM verification. Assert `stopNetworkLog()` is called exactly once in each path.

- [ ] **Step 3: Run focused tests and confirm RED where applicable**

Run:

```text
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
```

Expected: any missing preparation/cleanup guarantee fails before production edits.

- [ ] **Step 4: Split preparation from the one-way dispatch boundary**

Move the existing stable readiness check, guarded target check, and `startNetworkLog()`/mark acquisition into `BossSiteAdapter.prepareCommunicationDispatch()`, retaining prepared state only for the exact inspected job and tab. In `dispatchAndVerify()`, call that preparation while the item is `verified`; on preparation failure stop the item without incrementing `click_count`. Then recheck stop control, unresolved ambiguity, execution permission, and exact authorization before recording `click_dispatched`. `dispatchCommunication()` consumes the prepared state, performs an immediate target identity recheck, and clicks once. Do not move the durable ledger to after the physical click; preserve ambiguity on any failure after that boundary.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run the two commands above. Expected: PASS.

### Task 4: Verify both browser implementations and commit

**Files:**
- Modify only files required by failures found above.

- [ ] **Step 1: Run the complete communication regression set**

Run:

```text
node tests/browser_transport_smoke.js
node tests/communication_cli_authority_smoke.js
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: PASS; no test accesses real BOSS.

- [ ] **Step 2: Run the complete offline suite**

Run: `npm test`

Expected: every offline check passes.

- [ ] **Step 3: Perform a privacy/safety diff review**

Search changed code for request headers, post data, cookies, authorization, raw URLs, response-body persistence, automatic retries, and foreground calls. Confirm the adapter filters before storage and releases all WebSockets.

- [ ] **Step 4: Review and commit**

Run `git diff --check`, inspect every changed hunk, then commit the capability implementation and regressions with:

```text
fix: support communication verification in portable edge
```

- [ ] **Step 5: Leave real acceptance explicitly pending**

Do not reuse batch 1. After the workspace and eligibility phases pass and a fresh baseline is prepared, build a new immutable single-item batch and request explicit authorization for that exact external write before clicking.
