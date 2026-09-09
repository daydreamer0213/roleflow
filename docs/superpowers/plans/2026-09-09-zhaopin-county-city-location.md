# 智联县级市后缀修复 Implementation Plan

> REQUIRED: superpowers:subagent-driven-development. One tiny task with scoped spec/quality review under AGENTS proportionality; retain evidence. No historical task reopening or whole-branch review for this delta.

**Goal:** 已完整确认身份的同一岗位不因“昆山/昆山市”这类写法差异误停。
**Architecture:** Extend existing second-level administrative suffix normalization only.
**Tech Stack:** Existing CommonJS and synthetic Vue2 Playwright flow.

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly. You are not alone; preserve others' edits.
- Worker owns only src/adapters/sites/zhaopin.js (district suffix in sameLocation) and tests/zhaopin_readonly_smoke.js (existing synthetic Vue2 behavior). No other product files.
- Preserve existing exactComponentIdentity gate and every title/company/salary/URL/selected-card check, same-city/different-district rejection, raw detail location, JD quality/coverage, unique-job targets, budgets, pacing/cooldowns, checkpoints and scan-only recovery.
- No worker real browser/site/service/database/model access; no foreground, new retry/action, dependencies, helper/protocol/UI refactor, version change, push, merge, package, release or deletion. Main owns docs/live/final gate.
- Use existing fixtures and installed Node D:/hermes/node/node.exe; NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests. No full npm test by worker.

### Task 1: Include county-level city suffix in existing location equivalence

**Binding Global Constraints (verbatim):**

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly. You are not alone; preserve others' edits.
- Worker owns only src/adapters/sites/zhaopin.js (district suffix in sameLocation) and tests/zhaopin_readonly_smoke.js (existing synthetic Vue2 behavior). No other product files.
- Preserve existing exactComponentIdentity gate and every title/company/salary/URL/selected-card check, same-city/different-district rejection, raw detail location, JD quality/coverage, unique-job targets, budgets, pacing/cooldowns, checkpoints and scan-only recovery.
- No worker real browser/site/service/database/model access; no foreground, new retry/action, dependencies, helper/protocol/UI refactor, version change, push, merge, package, release or deletion. Main owns docs/live/final gate.
- Use existing fixtures and installed Node D:/hermes/node/node.exe; NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests. No full npm test by worker.

**Context:** sameLocation currently strips /(?:新区|区|县)$/ from the SECOND location part only; the FIRST city normalization already strips 市. The caller permits this path only with complete matching component IDs. Existing readonly test around newDistrictDetail/cityDetail contains true adapter checks, fixture reset and ID/conflict rejection.

- [x] Step 1: Before product edits, add a synthetic same-ID positive case to existing Vue2 flow: card location “合成市 甲 商圈”, detail first location tag “合成市·甲市”. Assert returned correct sourceId and unchanged detail.location. Add direct rejection for card “合成市 乙 商圈” against that same county-city detail, and ensure existing no-ID and city/district-conflict tests remain meaningful. No real city hardcoding.

Example (after setting the two DOM locations in the existing fixture):
```js
const countyState = await adapter.readSearchState("ZHAOPIN-SEARCH");
const countyDetail = await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", countyState.cards[0]);
assert.ok(countyDetail, "same confirmed job accepts county-level city suffix");
assert.equal(countyDetail.sourceId, countyState.cards[0].sourceId);
assert.equal(countyDetail.location, "合成市·甲市");
```

- [x] Step 2: Run node tests/zhaopin_readonly_smoke.js; actual null/assertion RED must precede source edit. Record command and failure.
- [x] Step 3: Only product change:
```js
const district = value => value.replace(/(?:新区|区|县|市)$/, "");
```
Keep every other branch/caller unchanged.
- [x] Step 4: GREEN node tests/zhaopin_readonly_smoke.js and node tests/zhaopin_communication_adapter_smoke.js; node --check changed source/test; git diff --check. Record warnings honestly; no full suite or unrelated warning cleanup.
- [x] Step 5: Self-review, commit only owned two files; full task report with RED/GREEN command/output to this plan's task-1-report.md. Return short status/SHA/concerns.

## Main continuation

- [x] Scoped review: Spec compliant/Approved, no findings. Actual original selected-job read passed09:34:46, correctID790chars/rawlocation/zeroactions/tabsunchanged.
- [ ] Final stable clean SHA strict full gate before overall completion or external greeting; prior79c2f04 full157 does not certify this new suffix delta.
- [x] Rechecked oldservice/bridge absent; restarted only ownedhelpers, exactdata-rootverified. Normal localUI Continue once showed scanning on the original run; no newbatch or target reduction.
- [ ] Continue whole scan/analysis and bounded ordinary greeting/messages/drafts; stop before reply send. No push/merge/release.

Source `edcd6be0d47b0f42fcce96ab4f34198c34c2628d`; task report/review retained in this plan's SDD workspace. ActualRED null assertion before one-line suffix edit,2focusedGREEN/syntax/diff passed. No new dependency, platformwrite, focus or JD quality/coverage change. Main continues genuine whole acceptance, not a task-level completion claim.
