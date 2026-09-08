# Zhaopin Initial Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户分析智联岗位后，在已有沟通清单选择岗位，后台串行发起网页普通打招呼，并在统一消息页查看回复、保存草稿。

**Architecture:** 复用现有独立沟通清单和不可变批次，不重写扫描工作流。智联找岗轮次仍在完整分析后结束，岗位结果提供“选择岗位打招呼”；独立批次可从沟通中心再次找到。执行来源、岗位和找回目标所需关键词全部从批次快照读取。智联独立适配器使用真实搜索面板“先聊聊”，不使用独立详情的 APP 下载入口。

**Tech Stack:** CommonJS、现有 SQLite 表、现有 Edge/CDP 浏览器与沟通执行器、合成页面及临时数据库测试。

## Global Constraints

- 真实验收可以发起新的普通沟通，但不得发送回复、同意或拒绝简历请求，也不得将投递或发送简历当作普通沟通。
- 所有真实平台操作后台串行，保留身份核对、节奏、额度、检查点与异常即停；不得激活平台页面或自动重试结果不明的外部写。
- 优先复用现有存储、模型、分析、任务及界面，不新增依赖、组件库、全局平台框架或虚构岗位缓存。
- 不推送、合并、打包、发布或更改版本；现有安装版、备份和生产资料不变。
- 实现者只使用 fixture、假浏览器和临时 DB；主控独占真实页面验收。BOSS 默认行为、校准状态、两固定页、可信 JD 主线和已有外部权限均不改变。
- 智联不继承 BOSS 的已验收结论；初次技术执行阶段为单岗位验收，成功后仍需独立记录，不自动升级为正式验收完成。

## Task 1: 单来源不可变批次与站点控制

**Files:** `src/storage/communication_store.js`, `src/application/communication/index.js`, `src/core/communication_calibration.js`, `src/core/communication_runtime.js`, `src/core/communication_executor.js`, `src/core/product_policy.js`, narrowly `src/core/candidate_progress.js` (`recordVerifiedCommunicationStart` only); new `tests/zhaopin_communication_storage_smoke.js`; existing communication storage/application/runtime/calibration/executor tests; register in `tests/run_all.js`.

**Interfaces:** Existing functions retain Boss defaults. `communicationCalibrationStatus(site='boss')`, `assertCommunicationExecutionEnabled(site='boss')`, `communicationQuotaSnapshot(db,{site='boss',now}={})`, `communicationRuntimeBlock(db,{site='boss',nowMs}={})`, `assertCommunicationRuntimeAvailable(db,{site='boss'}={})`, `isCommunicationJobEligible(db,job,{site='boss'}={})`. Batch creation consumes optional requested `site`, derives actual single source from selected plan-owned jobs (or frozen workflow source), and rejects mismatches. `batch.site` is the execution authority; input `site` alone is not authority. No new schema.

- [ ] **Step 1: RED.** Build complete synthetic ZL jobs under a real test plan and assert:

```js
assert.equal(batch.site, 'zhaopin');
assert.equal(batch.policySnapshot.zhaopin.targets[String(job.id)].sourceId, job.sourceId);
assert.equal(batch.policySnapshot.zhaopin.targets[String(job.id)].searchUrl, expectedFrozenSearchUrl);
assert.throws(() => createCommunicationBatch(db, mixedInput), {code:'COMMUNICATION_SOURCE_MISMATCH'});
assert.equal(countBatchesAfterRejectedMixedInput, countBatchesBeforeRejectedMixedInput);
```

Test wrong plan/profile/source, missing source ID/complete JD/semantic analysis, offline source evidence, archived or existing communication/application status, and mismatch between source ID and URL. A ZL rejection must not fall through BOSS eligibility. Existing BOSS eligibility remains exactly effective. Freeze search URLs from each stored job's real keyword plus `getPlatformSearchContext(db,{planId,site:'zhaopin'})`; messages-only keyword `message-discovery-detail` is not a real search keyword and is not eligible for new outreach. Missing native context yields a user-readable prepare/save instruction, not invented filters. Changing current plan conditions or job keyword after confirmation must not change frozen search targets.

Verify quota counts and reservations never cross sources, with already-reserved events idempotent; runtime risk in one site doesn't block or clear the other. Invalid sites fail closed. Preserve existing BOSS calls/results. Calibration and runtime are consulted with batch.site at start and immediately before dispatch. Direct executor/CLI cannot bypass single-item acceptance by omitting the item ID.

- [ ] **Step 2: Implement minimal source branches.** Derive site and validate selected jobs inside the existing batch transaction before source quota check and insert. Do not add an extra independently mutable source to items. Preserve shared browser authority and immutable batch state transitions. `policySnapshot.zhaopin={targets:{[jobId]:{sourceId,searchUrl}}}` stores only trusted same-platform lookup data, not full jobs or resumes. Build each URL using existing `buildZhaopinSearchUrl`; it is a lookup aid, not permission to contact any result it returns. Require complete JD, complete semantic result and existing communication qualification blockers for ZL; unknown BOSS HR activity is not a ZL exclusion.

Add a distinct `PRODUCT_POLICY.operations.zhaopinCommunication` policy using existing conservative pacing/limits: delay `[15000,20000]`, limits `{'10m':30,'30m':60,'24h':150}`, selection `{targetCount:30,acceptableMin:22}`. These are initial product limits, not a claim of empirically safe platform limits. Calibration remains `{implementation:'implemented',status:'dom_verified',acceptance:'e2e_pending',executionEnabled:false}` until browser and entry task reviews pass. Reuse existing site access accounting with actual site; do not copy BOSS calibration. Quota SQL must scope both reserved batch rows and matching access events.

Existing executor frozen job gains `{source:batch.site,searchUrl}` when ZL. Pass batch to the three immutableJob construction sites, including read-only retry and result verification. Execution-gate hooks receive site; retain no-argument test hook compatibility. Add ZL risk/login/page loss/identity/background failures to terminal-stop handling without broad catch-and-retry. Add only `zhaopin_prechat` to the sanitized endpoint evidence allowlist, preserve privacy filtering. Human-friendly error messages use actual platform. No success can be inferred solely from a click or a request being issued.

For ZL read-only lookup interruption before dispatch (including `ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND`), preserve the unclicked selected item for an explicit later resume instead of classifying it as a vacancy removal or a 24-hour unavailable job. Reuse the existing zero-click opening-item rollback helper `pauseCommunicationBatchAfterReservationFailure` (it does not erase access events), then record the interruption. Test single-item acceptance can resume that same pending item after the user fixes the browser; reserved/attempted access remains accounted and no automatic click retry occurs. Do not change BOSS interruption semantics.

ZL runtime browser shape is `{mode,windowId,searchTabId,searchReturnUrl,searchScrollTop,bindingGeneration}`; messageTabId is not required. Validate original URL as a trusted ZL search URL and preserve its keyword. BOSS still requires its two different tabs and BOSS URL. Same-site runtime rebind remains blocked by uncertain issued actions.

`recordVerifiedCommunicationStart` currently always calls `ensureFunnelEntry`, which rejects non-BOSS jobs and would roll back a verified ZL success. Keep the existing nested transaction and exact card/source ownership; for a validated ZL card persist contact event and waiting_reply but do not call the BOSS-only funnel function. BOSS still adds its funnel entry atomically. Do not loosen `funnel_store` source rejection. Test through the actual executor success path: ZL item and local progress succeed together, funnel row count remains unchanged; a forced local progress failure still rolls back the item transition.

- [ ] **Step 3: GREEN and commit.** Run new ZL storage smoke plus `communication_batch_storage_smoke`, `communication_application_smoke`, `communication_runtime_smoke`, `communication_calibration_gate_smoke`, `communication_executor_smoke`, syntax, `git diff --check`; record RED/GREEN and commit only owned files. Full suite belongs to main final freeze, not each task.

## Task 2: 真实搜索面板普通沟通适配器

**Files:** create `src/adapters/sites/zhaopin_communication.js`; narrowly extend `src/adapters/sites/index.js` to return this adapter for `site='zhaopin', context.operation='communication'`; new `tests/zhaopin_communication_adapter_smoke.js`, synthetic fixture `tests/fixtures/zhaopin/communication.html`; register in `tests/run_all.js`. Existing `src/adapters/sites/zhaopin.js` is reusable search reader, already updated by search compatibility plan before this task.

**Interfaces:** Export `ZhaopinCommunicationAdapter` extending existing `ZhaopinSiteAdapter`. It supports `captureCommunicationSearchState(tabId)`, `bindCommunicationTabs(binding)`, `beginCommunicationSession()`, `restoreCommunicationSearchPage()`, plus existing four execution methods `inspectCommunicationJob(job,signal)`, `prepareCommunicationDispatch(inspection,signal)`, `dispatchCommunication(inspection,signal)`, `verifyCommunicationResult(job,signal)`. `inspectZhaopinCommunicationTabs({browser,adapter})` exports a small read-only helper returning `{windowId,searchTab}` from one existing usable ZL search tab; no BOSS message tab requirement, no new window. Constructor supports existing browser/logger/accessController/sleepFn/randomFn and injectable `nowFn,timeoutMs=120000,pollIntervalMs=500`.

Constructor also accepts `pacingState` and `onPacingCheckpoint` for the existing shared ZL detail rhythm. CLI supplies these using existing get/setSitePacingState with site zhaopin; each issued pane read uses the same wait-after-action/checkpoint convention as scan, including failure, so process restarts do not reset accumulated pacing. Do not add a new scheduler or table.

**Live evidence:** Current `.job-card` Vue `JobCard.$props.job.number` is stable source ID; `.job-detail-summary` Vue `position.number` and `$props.jobDetail.detailedPosition.number` match trusted same-panel detail URL. Search actions are `.job-detail-summary__prechat` “先聊聊”, separate `.job-detail-summary__apply` “立即投递”. `preChat` calls `startChat` with widget `eventName:'preChat'`, `isShowAttachmentSelect:false`; normal result invokes `openImDetail` with same-tab `location.href`. Standalone “立即沟通” is APP QR only: never use it. No popup interception is needed or approved by this design.

- [ ] **Step 1: RED.** Synthetic browser tests cover existing target already selected; frozen keyword lookup finds exact card ID after normal navigation; equal title/different ID cannot dispatch; card/pane/link/title/company drift; two targets serially; risk/login/unrelated URL/window/active tab changes stop. Preserve old search adapters. Main evidence supports whitespace and legal suffix company normalization only with exact ID/title, not arbitrary fuzzy company match.

```js
assert.equal((await adapter.inspectCommunicationJob(frozenJob)).state, 'ready');
assert.equal(browser.calls.filter(x=>x.kind==='apply').length, 0);
assert.equal(browser.calls.filter(x=>x.kind==='prechat').length, 1);
assert.equal((await adapter.verifyCommunicationResult(frozenJob)).state, 'succeeded');
assert.equal(activeTabAfter, activeTabBefore);
```

Test delayed response, pre-click observer failure -> zero dispatch, mismatched/stale network response, correct request without response, application endpoint observed, greeting success without matching target evidence, changed frontend outcome, canceled wait, and uncertain dispatch -> no retry. Ensure preparation cancel/final cleanup release listeners/network log/focus emulation even on throws. Do not re-run actual clicks during tests.

- [ ] **Step 2: Implement bounded read-only target lookup.** Use the bound existing search tab as background working page. If its current selected exact target is ready, reuse it. Otherwise navigate once to frozen searchUrl, wait for actual keyword and native conditions using current search adapter, find exact card.sourceId and activate with existing guarded signature helper. Scroll normally under existing pacing/`list_scroll` budget until found, end-of-list or the existing 20-scroll checkpoint; not found is `ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND` interruption with remaining items preserved, not proof of vacancy removal. Every navigation consumes list_navigation; actual pane inspection consumes existing pane/detail budgets and checkpoints. Recheck source ID/title/company and active baseline immediately before ordinary button dispatch. Do not force hidden application state, call private Vue methods, replay private APIs, or weaken exact target to title matching.

Permit only the bound ZL search page or the platform's same-tab trusted `https://i.zhaopin.com/im` result while verifying. A consent, application, resume, login or risk modal is not handled automatically. Reuse current browser `clickAt` and the established held focus-emulation scope if required by actual browser contract; never bringToFront. One guarded click maximum. Return preparation.cancel and clean all observation resources on verification or session restore. Capture current search URL/scroll before execution and restore once at end if target/window/risk checks allow, leaving all user tabs open and active baseline unchanged. Never repair foreground by reactivating another tab.

- [ ] **Step 3: Verify actual result, not click acknowledgment.** Observe only the issued request to `/imapi/imV2/createAndUpdateContextV2` through existing browser network log. Request `jobNumber` must equal frozen source ID and `positionChatBeforeDeliveryScene='2'`, `positionChatBeforeDeliveryOperateType='2'`. The observed widget treats HTTP successful response with nonempty `data.sessionId` (or top-level sessionId) as context created, but rejects statusCode `2024,2025,2005,2006,2007` and actionCode `3000,3001`. Follow those explicit rejection semantics and require a valid session identity, not arbitrary truthy data. Observe application endpoint `/c/pc/alan/jobs/application` as a boundary violation; never issue it yourself.

Success additionally requires either current exact job still selected plus the newly appearing exact modal text “已向对方发送打招呼语”, or a same-tab IM session whose session/job identity matches this new request and whose current outgoing greeting is visible. Existing unrelated success banners or generic IM URLs do not suffice. Read target response narrowly in memory; persist only endpoint kind/status/category/elapsed and boolean diagnostics, never URLs with query secrets, resume/staff/user IDs, response bodies or tokens. Unknown outcome remains ambiguous and stops. Existing or continuation-only entry is not a new send; without separately verified prior-contact evidence return unavailable rather than fabricating success.

- [ ] **Step 4: GREEN and commit.** Run new adapter smoke, `zhaopin_readonly_smoke`, `communication_executor_smoke`, `communication_cli_authority_smoke`, syntax, diff check. Report exact RED/GREEN, DOM assumptions and no real actions. Commit only owned files for independent review.

## Task 3: 产品入口、子进程与再次使用

**Files:** `src/cli.js`, communication-specific sections of `src/dashboard/server.js`, `src/dashboard/view_models/communication.js`, `src/dashboard/pages/communication.js`, narrow user-facing labels in `src/dashboard/user_facing_errors.js` / `src/dashboard/status_labels.js`, capability copy only in `src/dashboard/view_models/today.js` / `src/dashboard/pages/today.js`; `src/core/product_policy.js` calibration only; new `tests/dashboard_zhaopin_communication_smoke.js`; extend `tests/communication_cli_authority_smoke.js`, `tests/dashboard_zhaopin_smoke.js`, communication UI/HTTP tests as affected; register tests.

**Interfaces:** `/communication/new?planId=<id>&site=zhaopin` selects only eligible source-specific jobs and submits `{site,planId,jobIds,browserMode}` to the existing endpoint, without workflowRunId. `/communication?planId=<id>&site=zhaopin` restores same-owner source batches, including direct batches not linked to a workflow. Batch-specific URLs derive source from DB and reject supplied conflicting source/owner. Child launch still passes immutable batchId only; CLI reads batch.site and asks `createSiteAdapter(site,{operation:'communication',...})` for the implementation. Shared execution lease remains existing mutual exclusion across platforms.

- [ ] **Step 1: RED.** Real HTTP/temporary DB test: eligible ZL analysis -> source-specific selection -> confirmation -> single-item start handler -> isolated fake process -> progress -> reload/direct batch lookup/history. Prove BOSS rows absent, cross-source or cross-profile input rejected, later current plan/site mutation cannot select a different adapter, and direct batch remains findable by ordinary navigation after restart. No test factory writes fake success into actual acceptance DB.

```js
assert.equal(created.body.batch.site, 'zhaopin');
assert.equal(spawnArgs.includes('--site'), false);
assert.equal(adapterFactoryCalls[0].site, 'zhaopin');
assert.equal(restored.body.includes('合成智联岗位'), true);
assert.equal(realReplyOrApplyCallCount, 0);
```

- [ ] **Step 2: Wire product with minimum surface.** Add compact “选择岗位打招呼” entry to ZL result/queue, preserving existing analysis text and avoiding BOSS application/reply/follow-up controls. Keep completed readonly scan workflow semantics; do not invent a communication target in old completed runs. ZL builder displays only selected count and available candidates, no BOSS-specific quota-filling advice. Use existing checkboxes/confirmation/control page, source labels and existing single-item acceptance control. Links back to plan/queue/new list preserve work source. Communication center includes source/owner-scoped direct batches alongside existing workflow records without duplicates; prioritize unfinished batches, then most recent; history links remain immutable batch IDs.

Align capability copy: platform option becomes “智联” rather than “智联（只读）”; today heading explains “发现并分析岗位，再选择合适的岗位打招呼。” The scan itself remains read-only, so keep that accurate boundary near its start action. Do not imply new reply-send or application capability. Existing BOSS copy/controls remain unchanged.

CLI validates capabilities and runtime by frozen batch.site. For ZL use `inspectZhaopinCommunicationTabs`, capture/bind/begin/restore interface from Task 2. BOSS branch remains its existing lifecycle. Rebind calls the same read-only ZL inspection and remains blocked for issued uncertain actions. Record runtime risk under actual site. ZL communication success may record existing local progress via `recordVerifiedCommunicationStart` with source ZL, but this is not authorization to expand the feedback funnel or reply endpoints.

After Task 2 independent review passes, set only ZL calibration.executionEnabled true with acceptance still `e2e_pending` and status `dom_verified`, allowing the pre-existing single-item acceptance path. Display it naturally as “页面已核对，正在进行单岗位验收”; do not claim formal acceptance or reuse BOSS accepted. Do not provide an environment variable or user form toggle to bypass technical/identity gates.

- [ ] **Step 3: GREEN and commit.** Run new HTTP/CLI tests plus existing `dashboard_communication_batch_smoke`, `communication_cli_authority_smoke`, `communication_application_smoke`, `workflow_communication_smoke`, `zhaopin_workflow_smoke`, `dashboard_zhaopin_smoke`, syntax, diff check. Use strict Playwright environment as in other phase plans; main owns final full suite and real browser acceptance. Record focused failures and final outputs, commit owned files only.

## Final verification by main

After all tasks and the other current phase plans pass task review, run one broad review and fresh full `npm test` at frozen code. Restart only the isolated acceptance service. From actual local product UI use existing resume/plan, prepare/save native ZL search, read a small new set of full JDs, run actual model analysis, select one eligible exact job and execute one ordinary greeting, then read existing genuine inbound messages and save generated reply draft. Record which reply was historical; do not wait for or invent instant HR responses. Stop before reply send. If any unavoidable real platform action exceeds ordinary greeting, preserve the result and ask the user only for that new authority.
