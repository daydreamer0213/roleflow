# Zhaopin Communication Background Lookup Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for this one bounded task. Earlier completed tasks remain closed.

**Goal:** Locate existing Zhaopin jobs in background-loaded result pages without weakening identity validation.

**Architecture:** Reuse `openSearchRenderScope` around communication inspection, as scanning already does. Preserve nested readiness scopes and guaranteed cleanup.

**Tech Stack:** CommonJS, existing Playwright fixtures and fake browser.

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly; read root AGENTS.md. No real browser, live DB, service, full gate, version, push, merge or release operations by worker.
- Own src/adapters/sites/zhaopin_communication.js and tests/zhaopin_communication_adapter_smoke.js; src/adapters/sites/zhaopin.js only to export the existing releaseSearchRenderScope helper for reuse. Do not revert others' edits. No new module or dependency.
- Preserve exact identity checks, existing20scroll cap, pacing, access reservations, login/risk stops and zero retry of communication dispatch. No foreground or viewport changes.
- Main owns services, genuine acceptance, documentation and full gate. Old1eb48e2 gate157/157 is historical after source changes.

## Task 1: Hold existing rendering support through target lookup

- [ ] Read the matching design and production inspectCommunicationJob/currentSelectedInspection/inspectCard/openSearchRenderScope flow; use existing fakeBrowser and synthetic communication fixture.
- [ ] Add one realistic background-list regression: after normal search navigation, next-page JobCard exists but its DOM title is blank until existing focus-emulation support is held; provide fake setPageLifecycleActive and cdp support only for these test cases. Call `inspectCommunicationJob(JOB_B)` and assert ready/exact sourceId, zero prechat/application clicks, unchanged active tab, rendering disabled after success. Old source must fail TARGET_NOT_FOUND, not setup/syntax.

```js
const inspection = await adapter.inspectCommunicationJob(JOB_B);
assert.equal(inspection.state, 'ready');
assert.equal(inspection.sourceId, JOB_B.sourceId);
assert.equal(browser.calls.filter(call => call.kind === 'prechat').length, 0);
assert.equal(browser.state.focusEnabled, false);
```

- [ ] Run `D:/hermes/node/node.exe tests/zhaopin_communication_adapter_smoke.js` and record actual RED before source changes.
- [ ] In inspectCommunicationJob hold one nullable release callback and original error. For an existing search page open scope before currentSelectedInspection; for verified IM-return open after normal navigation. Let nested waitForSearchReady reuse it. Finally release on every path and always call this.end('inspection'); preserve cleanup failure with original cause. Use existing patterns; no new generic wrapper/helper.

```js
let releaseSearchRendering = null;
let operationError = null;
// After safety-checked search binding:
releaseSearchRendering = await this.openSearchRenderScope(this.binding.searchTabId);
// Keep existing inspection work inside the try; reuse non-null release after navigation.
// catch: preserve operationError and rethrow; finally: release, attach cause if needed, always end.
```

- [ ] Add bounded not-found and cancellation cases verifying rendering release and zero dispatch. A cleanup failure must still clear inspection busy state and must not authorize a click. Reuse the existing releaseSearchRenderScope AggregateError behavior to retain both failures even when cleanupError already has its own cause; test a combined lookup+cleanup failure.
- [ ] GREEN: zhaopin_communication_adapter_smoke, zhaopin_readonly_adapter_smoke, dashboard_zhaopin_communication_smoke, zhaopin_communication_storage_smoke (verify exact test filename with rg first). Syntax and git diff --check. NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP/TMP=D:/DevData/RoleFlow-tests.
- [ ] Self-review and commit only owned files. Report exact SHA, actual RED/GREEN, files, concerns. Main arranges one bounded spec+quality review, not re-reviewing the old110commits.
