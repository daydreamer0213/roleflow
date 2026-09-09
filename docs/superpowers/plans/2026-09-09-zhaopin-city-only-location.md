# 智联同岗位城市级地点兼容 Implementation Plan

> REQUIRED: superpowers:subagent-driven-development. One bounded implementation and scoped spec/quality review, following the project's proportionality rules. Historical closed tasks stay closed; retain evidence workspace. User approved continuous execution.

**Goal:** 同一已验证岗位的地点详略差异不再阻断读取。
**Architecture:** Extend existing sameLocation under its existing exact-ID gate; no caller or protocol changes.
**Tech Stack:** Existing Node/CommonJS and routed synthetic Playwright fixture; no dependencies.

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; you are not alone, preserve others' edits.
- No worker real browser/site/service/database/model access, no foreground, screenshots, viewport changes, platform refresh, communication, application or resume actions.
- Broader location compatibility requires existing exactComponentIdentity: fully confirmed detail IDs plus a supplied reliable current card ID equal to detail ID. Preserve every title/company/salary/URL/selected-card guard.
- Accept nonempty same-city city-only versus finer location, symmetrically, using existing separator and terminal 市 normalization. If both specify a district, keep existing district comparison; cross-city, explicit district conflict, empty location and unreliable/mismatched IDs remain rejected.
- Preserve original detail.location text, full JD quality/coverage, unique-job targets, physical access budgets, pacing/cooldowns, checkpoints and scan-only one empty-detail recovery. No new click or retry behavior.
- Reuse existing sameLocation and synthetic Vue2 fixture. No city dictionary, hardcoded real city/business area, new dependency, interface/UI/helper-protocol change, unrelated refactor, version change, push, merge, package, release or deletion.
- Main owns docs, live acceptance and final strict full gate; worker owns only source/test below and focused offline tests, with generated files on D:.

### Task 1: Handle city-only location under exact component identity

**Owned files:** src/adapters/sites/zhaopin.js (sameLocation only); tests/zhaopin_readonly_smoke.js (existing Vue2 fixture behavior checks).

**Binding Global Constraints (verbatim):**

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; you are not alone, preserve others' edits.
- No worker real browser/site/service/database/model access, no foreground, screenshots, viewport changes, platform refresh, communication, application or resume actions.
- Broader location compatibility requires existing exactComponentIdentity: fully confirmed detail IDs plus a supplied reliable current card ID equal to detail ID. Preserve every title/company/salary/URL/selected-card guard.
- Accept nonempty same-city city-only versus finer location, symmetrically, using existing separator and terminal 市 normalization. If both specify a district, keep existing district comparison; cross-city, explicit district conflict, empty location and unreliable/mismatched IDs remain rejected.
- Preserve original detail.location text, full JD quality/coverage, unique-job targets, physical access budgets, pacing/cooldowns, checkpoints and scan-only one empty-detail recovery. No new click or retry behavior.
- Reuse existing sameLocation and synthetic Vue2 fixture. No city dictionary, hardcoded real city/business area, new dependency, interface/UI/helper-protocol change, unrelated refactor, version change, push, merge, package, release or deletion.
- Main owns docs, live acceptance and final strict full gate; worker owns only source/test below and focused offline tests, with generated files on D:.

**Interfaces/context:** detailMatches already passes exactComponentIdentity as sameLocation's third argument. Keep this gate/caller unchanged. sameLocation currently splits separators, requires both arrays length >= 2, then compares city and district normalized values. Existing Vue2 fixture around readonly_smoke lines 311-345 supplies reliable IDs and district/conflict/IDless cases.

- [x] Step 1: Add actual adapter behavior tests before product edits, using the existing page/bridge/fixture. Mutate card location to synthetic city plus district/business area and summary's first tag to city-only; readSearchState then readVisiblePaneDetail must return the correct sourceId and exact unexpanded detail.location. Cover reverse granularity, city suffix, cross-city, explicit two-sided district conflict, empty detail location and missing/mismatched IDs. Reuse existing conflict coverage instead of duplicating unrelated cases.

Example of the observed-class assertion within the existing test flow:

```js
await page.evaluate(() => {
  document.querySelector("#vue2-card .job-card__location").textContent = "合成市 甲 商圈";
  document.querySelector("#vue2-summary .job-detail-summary__tags li").textContent = "合成市";
});
const cityState = await adapter.readSearchState("ZHAOPIN-SEARCH");
const cityDetail = await adapter.readVisiblePaneDetail("ZHAOPIN-SEARCH", cityState.cards[0]);
assert.ok(cityDetail, "same confirmed job accepts city-only detail location");
assert.equal(cityDetail.location, "合成市");
```

- [x] Step 2: Run node tests/zhaopin_readonly_smoke.js before product changes; record the actual expected assertion failure, not a version/source-presence failure.
- [x] Step 3: Minimal sameLocation change: after split require both arrays nonempty, then require equal normalized cities; if either array has one part return true; otherwise retain normalized district equality. Keep early compact-equality and allowBusinessDistrict gates.

```js
if (!leftParts.length || !rightParts.length) return false;
const city = value => value.replace(/市$/, "");
if (city(leftParts[0]) !== city(rightParts[0])) return false;
if (leftParts.length === 1 || rightParts.length === 1) return true;
const district = value => value.replace(/(?:新区|区|县)$/, "");
return district(leftParts[1]) === district(rightParts[1]);
```

- [x] Step 4: Focused GREEN: node tests/zhaopin_readonly_smoke.js; node tests/zhaopin_workflow_smoke.js; node tests/zhaopin_communication_adapter_smoke.js; node --check on changed source/test; git diff --check. Report actual commands/results/warnings. Do not run full npm test; main owns final gate.
- [x] Step 5: Self-review, commit only owned source/test, report full RED/GREEN evidence to this task's report file; return short status/SHA/concerns.

Environment: Node D:/hermes/node/node.exe; NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests. No installs.

## Main continuation

- [x] Scoped review: Spec compliant / Approved, no Critical/Important. One non-blocking environmental SQLite/CRLF output-noise note retained in ledger; no unrelated suppression/config changes. Main verified untouched caller and scan guards and current live read; final full gate remains separate.
- [ ] Final docs/clean frozen SHA/strict full gate; only owned isolated8788 restart, no platform refresh.
- [ ] Fresh current-tab read-only validation of original selected job; ordinary local UI continue once on original run/batch, retaining coverage and checkpoints.
- [ ] Continue real scan/analysis then at most one approved ordinary greeting and messages/drafts, stopping before reply send; no push/merge/release.

## Verified implementation checkpoint

Source `d85173acdf382e7afb8f7b9282e1d97374bfccd6`: actual city-only null assertion RED before product edit; readonly/workflow/communication adapter GREEN, source/test syntax and diff passed. Only sameLocation and existing synthetic fixture checks changed. Scoped review passed with no blocking findings. At08:39 UTC main used the actual adapter on the original already-selected failed job: exact ID matched, original city-only location preserved,271-character JD, zero actions,6tabs/activeunchanged. Evidence `city-only-detail-verified-20260909.json` outsideGit. This read-only check is not full scan/analysis or greeting acceptance. Owned8788 restarted on the same isolated data-root; old bridge process had exited, restarted existing bridge only and authenticated healthy, no browser restart/login changes. Local-only reload showed94/93/1 and Continue. New frozen full gate and actual original-run resume next.
