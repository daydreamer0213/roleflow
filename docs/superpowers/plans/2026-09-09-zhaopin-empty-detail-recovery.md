# 智联空详情后台单次恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One bounded implementation/review task; main owns live acceptance and final gate.

**Goal:** 已选中且加载停止的空详情后台正常激活一次，不干等、不增加发送重试。
**Architecture:** 当前 helper 仅读可靠卡片绑定的原生状态；scan 显式注入一次恢复节奏回调。沿用读取循环、身份、额度和检查点。
**Tech Stack:** Node22/CommonJS, Vue2/3 DOM, current adapters/pacing, SQLite, Playwright fixture.

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; preserve unrelated edits.
- Background only: no Page.bringToFront, tab/window activation, page refresh, screenshot/viewport mutation, private API replay, reply send, resume consent/refusal, application, push, merge, release or version change.
- Recovery is scan-only and limited to one same-card reactivation per readVisiblePaneDetail call; existing communication preparation/dispatch gets no new retry.
- Retain exact current card/index/signature/source identity, keyword/filter scope, abort/risk/login/page/lease checks, physical access accounting, random pacing, detail cooldown/checkpoints and complete-JD quality/coverage.
- Keep the 120000ms maximum genuine-loading wait and fast non-loading identity rejection; unknown/partial/conflicting detail is never evidence permitting reactivation.
- Use existing Node/CommonJS, browser adapter, BossSiteAdapter pacing and tests; no new dependencies, generic retry framework, settings or UI.
- All worker validation is offline with synthetic fixtures, fake browser and temporary databases on D:; main alone owns live browser, service and final strict full gate.
- The user has approved the direction and delegated implementation details; continue without repeated user approval. Report genuine scope/authority problems to main.

---

### Task 1: Implement and verify selected-empty scan recovery

**Owned files:** src/adapters/sites/zhaopin.js; tests/zhaopin_workflow_smoke.js; tests/zhaopin_readonly_smoke.js; optionally minimal tests/fixtures/zhaopin/search-vue2.html. Main owns docs/browser/service/final gate. No other product module changes without concrete need reported.

**Interfaces:**
- readVisiblePaneDetail(tabId, card, signal=null, assertTabBindings=null, beforeEmptyRetry=null). Existing four-arg communication caller receives NO new retry.
- waitForSearchReady options.allowPendingDetail=false; only scan sets true to let restored filters plus reliable selected card and known loading/empty progress to the detail reader.
- helper detailRequestState='loading'|'empty'|'ready'|'unknown', version8→9.
- Existing component(card,'JobCard') resolves Vue2/3; use (instance.proxy || instance).$store.state selectively, only selectedJobId, jobDetailLoading, jobDetail. Current real selected card remains active after failure; absence of DOM fields alone does not prove request ended.

**Binding constraints for this task (verbatim):**

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; preserve unrelated edits.
- Background only: no Page.bringToFront, tab/window activation, page refresh, screenshot/viewport mutation, private API replay, reply send, resume consent/refusal, application, push, merge, release or version change.
- Recovery is scan-only and limited to one same-card reactivation per readVisiblePaneDetail call; existing communication preparation/dispatch gets no new retry.
- Retain exact current card/index/signature/source identity, keyword/filter scope, abort/risk/login/page/lease checks, physical access accounting, random pacing, detail cooldown/checkpoints and complete-JD quality/coverage.
- Keep the 120000ms maximum genuine-loading wait and fast non-loading identity rejection; unknown/partial/conflicting detail is never evidence permitting reactivation.
- Use existing Node/CommonJS, browser adapter, BossSiteAdapter pacing and tests; no new dependencies, generic retry framework, settings or UI.
- All worker validation is offline with synthetic fixtures, fake browser and temporary databases on D:; main alone owns live browser, service and final strict full gate.
- The user has approved the direction and delegated implementation details; continue without repeated user approval. Report genuine scope/authority problems to main.

- [x] **Step 1: Add focused behavior regression and verify RED/GREEN (sequencing deviation below).**

Original plan required behavioral RED before product edits. The first RED only failed the helper version assertion, so that sequencing requirement was not met. Review requested a post-implementation counterproof: identical recovery-success assertion against isolated BASE failed exit1, while current production code passed exit0. The report records both honestly; this does not retrospectively claim tests-first ordering.

Use existing Vue2 fixture/card/summary. Attach explicit store state using trusted synthetic ID, false jobDetailLoading and null jobDetail; save and remove summary/body/link content, restore from native card-click listener only. Fake time, not real120seconds. Real adapter/helper must fail on old implementation (timeout/zeroactivation), not missingimports. Representative assertion:

```js
let retryWaits=0;
const detail=await adapter.readVisiblePaneDetail(tabId,currentCard,null,null,async()=>{retryWaits++;});
assert.equal(detail.sourceId,'CCSYNTHV2A1J00000000001');
assert.equal(retryWaits,1);
assert.equal(await page.evaluate(()=>window.emptyDetailActivations),1);
```

Extend existing workflow fake only as needed. Tests exercise actual adapter:
1. already-selected stopped-empty→1reactivation→full same-ID result;
2. unselected first click ends-empty→1extra activation→same-ID result;
3. extra activation still empty→bounded failure, no secondretry/no nextcard, prior checkpoint preserved;
4. actual loading→wait/no extra activation; unknown/partial/conflicting ID cannot permit retry;
5. state late-valid during pacing/reservation→no needlessclick; changedtarget/scope, pause, deniedaccess→no subsequentclick;
6. scan first-card empty passes restored-filter readiness; default waitForSearchReady still requires previous readiness;
7. actual recovery reserves two physical visits, one logicaljob; pacing records both including finalfailedattempt.
Keep existing slow-load, short-JD, identity and communication regressions. Record RED command/output in report.

- [x] **Step 2: Implement smallest state/loop integration.**

Derive known state only from exact current reliable selected ID and strict boolean/null fields. No absent-store-as-false. empty also needs all three DOM detail identity/content fields empty and no visibleloader. Preserve existing loading contract for legacy/unknown fields and all risk/login checks.

Add optional expected-empty guard to existing activation helper; re-evaluate exact signature/selectedcard/empty state inside same browser evaluation immediately before card.click. Late-ready/loading cancels click for re-read; target changes stop.

One retry-used flag, existing120000ms genuine-loading budget. Exclude measured elapsed time in beforeEmptyRetry from the wait deadline (the existing macro cooldown can be150seconds); do not restart a fresh120second budget or bypass cooldown. At most once call beforeEmptyRetry, re-read card/signature/selection/state, reserve extra access, re-read and guard activation. After issued recovery wait one normal short sample before declaring still-empty failure. True loading keeps waiting; retry still stoppedempty uses existing ZHAOPIN_DETAIL_LOAD_TIMEOUT and user-facing message, not another retry. Keep original six-sample fast nonloading identity rejection.

Scan wiring reuses existing pacing:

```js
const detailPacingOptions={signal:options.signal,assertTabBindings:scoped,onPacingCheckpoint:options.onPacingCheckpoint};
const beforeEmptyRetry=async()=>{
  await pacing.waitAfterDetailAction(detailPacingOptions);
  await pace('pane_detail_read',scoped);
  await pacing.waitForPendingDetailCooldown(detailPacingOptions);
};
let detail;
try { detail=await this.readVisiblePaneDetail(tabId,card,options.signal,scoped,beforeEmptyRetry); }
finally { await pacing.waitAfterDetailAction(detailPacingOptions); }
```

Remove old success-only later waitAfterDetailAction to avoid double count. Preserve original exception if cleanup also fails (reuse project error-preserving style). Callback closes previous attempt; finally closes final attempt even failed. Extra reserve occurs before recovery, logical map/details semantics unchanged. If outline has a demonstrable accounting ambiguity, ask main with evidence; don't weaken constraints. Existing pacing/budget rules stay unchanged, not new constants/configuration.

allowPendingDetail only scan: restored filter/keyword + reliable selected card and known loading/empty may exit waitForSearchReady into guarded reader. Unknown/default call contract unchanged. Do not enable communication retries.

- [x] **Step 3: Focused GREEN, self-review, commit owned files.**

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:TEMP='D:/DevData/RoleFlow-tests'
$env:TMP='D:/DevData/RoleFlow-tests'
& 'D:/hermes/node/node.exe' tests/zhaopin_readonly_smoke.js
& 'D:/hermes/node/node.exe' tests/zhaopin_workflow_smoke.js
& 'D:/hermes/node/node.exe' tests/zhaopin_communication_adapter_smoke.js
& 'D:/hermes/node/node.exe' tests/workflow_scan_analysis_smoke.js
& 'D:/hermes/node/node.exe' --check src/adapters/sites/zhaopin.js
git diff --check
```

Verify entrypoint paths. Record known SQLite experimental/CRLF notices without suppressing genuine errors. Main owns one final strict full suite after freeze; worker does not run duplicate full gate, live browser or model. Explicit git add owned files only, then commit. Full report includes RED/GREEN commands/output, changes, accounting, caller checks, concerns; brief final status/commit/test/reportpath only.

## Main after scoped review

- [x] Resolve single task spec/quality gate; previously closed tasks remain closed. `66e5467`: Spec compliant, quality Approved; no Critical/Important. Known SQLite experimental/CRLF notices recorded, not suppressed. Four focused GREEN, syntax/diff pass.
- [ ] Verify and restart only owned isolated8788 process, freeze clean SHA and fresh strict full gate.
- [ ] Read existing helper state in background, resume same real run from normal Dashboard UI without reduced targets/quality or direct API shortcuts.
- [ ] Verify actual scan/currentbatch analysis; at most one ordinary initial greeting only with existing authority, current eligible exacttarget proof and full gate, then messages/drafts; stop before reply send.
- [ ] Record exact SHA/test results/real coverage/externalactions/remaining limits; no push/merge/build/release.
