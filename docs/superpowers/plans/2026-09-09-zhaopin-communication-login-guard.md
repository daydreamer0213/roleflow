# Zhaopin Communication Login Guard Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for this single bounded task. Do not reopen earlier completed tasks.

**Goal:** Normal authenticated account headers must not block communication inspection, while real login challenges still stop it.

**Architecture:** Reuse exported `isVisibleZhaopinLoginChallenge` from zhaopin_message_reader in the communication snapshot. Narrow any whole-account-subtree exemption only as required to preserve real nested login panels. No new module or dependency.

**Tech Stack:** Existing CommonJS and Playwright synthetic fixtures.

## Global Constraints

- Read root AGENTS.md and the matching Sep9 design. Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly. No live browser/DB, services, full gate, push/merge/release/version changes by worker.
- Main owns real browser/services, outside-Git quota configuration, documentation and final gate. Preserve others' edits. Previous progress fix is CLOSED; its frozen337fe25 gate passed157/157. This new bug needs fresh validation after its fix.

## Task 1: Reuse the actual login challenge guard

**Owned files:** src/adapters/sites/zhaopin_communication.js; narrowly src/adapters/sites/zhaopin_message_reader.js; tests/zhaopin_communication_adapter_smoke.js and, only for shared-helper behavior, tests/zhaopin_message_reader_smoke.js. No other changes without reporting necessity.

- [ ] Add a synthetic home-header__right containing home-header__b-login and home-header__c-login/c-login__top/name/photo matching the observed shape; no real personal data. Through the production adapter assert `inspectCommunicationJob(JOB_A).state === 'ready'` and zero prechat/application clicks. Add visible real login panel under that account subtree and moved account outside expected parent cases; assert LOGIN_REQUIRED and zero dispatch. Test must fail on the old broad selector, not syntax/setup.
- [ ] Run `D:/hermes/node/node.exe tests/zhaopin_communication_adapter_smoke.js` and record actual RED before production changes.
- [ ] Import existing helper, serialize it into the snapshot expression and replace `.some(visible)` for login detection with `.some(isVisibleZhaopinLoginChallenge)`. If needed narrowly limit the helper's home-account exemption to known ordinary node shapes so nested login-panel remains blocking. Preserve visibility/aria-hidden and all other guards.
- [ ] GREEN: communication adapter, zhaopin_message_reader_smoke, zhaopin_message_detail_reader_smoke, dashboard_zhaopin_communication_smoke; syntax and git diff --check. NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP/TMP=D:/DevData/RoleFlow-tests. Do not run full npm test.
- [ ] Self-review, commit owned source/tests only; report exact SHA, RED/GREEN and remaining concerns. Main arranges one bounded spec+quality review, live read-only recheck and frozen full gate before any new real ordinary greeting.
