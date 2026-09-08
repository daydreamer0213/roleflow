# Zhaopin Message Job Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 无本地智联岗位缓存的新消息，通过真实会话岗位链接补全 JD 与现有分析，然后产生可编辑持久回复草稿。

**Architecture:** 扩展现有智联 reader 的已选岗位目标接口；新增小型智联详情 reader；现有智联 resolver 走缓存优先、详情采集、现有单岗位分析和重新校验完整上下文。复用现有页面、存储和节奏/额度控制，不建设第二套分析链。

**Tech Stack:** CommonJS、SQLite、既有 EdgeControl/CDP browser contract、合成 DOM/浏览器与临时 DB 测试。

## Global Constraints

- 真实页面操作由主控负责；实现者只使用合成 fixture，不访问平台或真实用户数据。
- 每次最多一个同窗后台临时详情页；始终串行，active:false，禁止 bringToFront，所有已发起尝试计额度并执行清理和节奏检查点。
- 只接受已选真实会话提供、编号严格匹配的智联岗位链接；缺失、错位、登录/风控、页面丢失、取消或清理失败不得产生草稿或假成功。
- 缓存限定同平台、同用户、当前有效方案和完整分析；已有完整资料不消耗详情访问额度。
- 不发送初次沟通或回复，不同意/拒绝简历，不投递，不引入新依赖，不更改 BOSS 主线行为。
- 不推送、合并、打包、发布或更改版本；现有安装版、备份和生产资料不变。

## Task 1: 消息岗位详情与上下文补全

**Files:**
- Modify: `src/adapters/sites/zhaopin_message_reader.js`
- Create: `src/adapters/sites/zhaopin_message_detail_reader.js`
- Modify: `src/application/message_discovery/zhaopin_job_context.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/core/message_discovery.js`
- Modify narrowly for source metadata: `src/application/analysis/index.js`
- Modify narrowly for availability label: `src/dashboard/message_discovery_view.js` (only after prior UI task completes)
- Test: `tests/zhaopin_message_reader_smoke.js`, `tests/zhaopin_message_discovery_smoke.js`
- Create Test: `tests/zhaopin_message_job_context_smoke.js`, `tests/zhaopin_message_detail_reader_smoke.js`
- Register tests in `tests/run_all.js`.

**Interfaces:**
- `messageReader.readSelectedJobTarget(selected, signal)` -> `{jobId, navigationUrl, canonicalUrl, availability}` where jobId is unprefixed, availability is `offline` or `unknown` (absence of an offline badge does not prove active recruitment). It must re-read and verify the current bound tab, row/main/header session and job identity against the previously returned selected object, not trust an arbitrary caller-provided object. Add an internal selected-result identity reference/digest as needed within the existing reader; never expose peer IDs.
- `createZhaopinMessageDetailReader({browser,messageReader,beforeOpen,afterIssuedAttempt,sleepFn,nowFn,timeoutMs=120000,pollIntervalMs=500})` -> `{readSelectedJobDetail({communicationTabId,selected,jobTarget,signal})}` returns `{source:'zhaopin',sourceId,canonicalUrl,title,company,location,salary,experience,education,tags,description,availability}`. Export a pure snapshot/parser or expression for synthetic DOM tests. Canonical URL is `https://www.zhaopin.com/jobdetail/<id>.htm`; observed `.html` accepted only as the same id and canonicalized narrowly here, not a general URL permissiveness rewrite.
- Existing `createZhaopinMessageJobContextResolver(options)` retains cache-only operation if readers omitted for old injected tests, but actual controller supplies both readers. It gains the same `analyzeJob`, `modelConfig`, `root`, `logger`, `analysisDeps`, `now` dependency pattern as the BOSS resolver. No-cache+no-reader remains explicit unavailable.
- Resolver returns the existing `{cardId,card,job,threadKey,contextSource}`; source is `local_cache` or `message_discovery_detail`.
- `createMessageDiscoveryDetailSafety` gains optional `platform='boss'`; its existing pacing implementation can be reused, but pacing state, accessController.site and runtime checks must use the actual site. BOSS defaults remain unchanged. Controller creates safety/detail reader for ZL too and passes platform. Shared browser execution lease remains existing mutual exclusion, not a second independent run lock.

- [ ] **Step 1: Write and observe failing behavior tests.** Extend live-structure synthetic reader fixture with `.im-chat-header__detail`, preserving parameterized IM URL and header/login regressions. Add standalone detail fixture generated from observed selectors with synthetic names/text. Test:

```js
assert.equal(target.jobId, 'CCSYNTH001J00000000001');
assert.equal(target.canonicalUrl, 'https://www.zhaopin.com/jobdetail/CCSYNTH001J00000000001.htm');
assert.equal(detail.sourceId, 'CCSYNTH001J00000000001');
assert.equal(detail.title, '合成软件工程师');
assert.equal(detail.company, '合成科技有限公司');
assert.equal(result.contextSource, 'message_discovery_detail');
assert.equal(result.job.source, 'zhaopin');
assert.equal(result.job.analysis.semanticStatus, 'complete');
```

Cases: no cache -> one detail read, one existing analysis call, complete own-platform stored job/card and draft; complete cache -> zero detail opens/analysis; two identical job IDs across platforms/users cannot share context; current plan missing/context analysis failure preserves pending original text and no processed marker. Reader rejects forged/stale selection, wrong URL host/id, inconsistent header or detail title; known full company legal suffix difference is accepted only with exact stable job ID and matching title, arbitrary different companies rejected. Slow `readyState=loading` with complete stable body succeeds; skeleton/empty/incomplete body waits cancellably then fails; content changed during two readiness samples re-waits. Open wrong window/active tab/changed baseline/throw after physical open must close attributable tab, account attempt and stop. No cleanup closes pre-existing user tabs.

- [ ] **Step 2: Implement minimal reader and resolver.** Read-only snapshot selectors are `.summary-planes__title`, `.summary-planes__salary`, `.summary-planes__info li`, `.describtion-card__detail-content`, `.describtion-card__skills-item`, `.company-info__name` (fall back to same-job `.company-summary__name-link` only). Limit body to actual JD, not related jobs/SEO/footer. Require title, company and at least 120 trimmed characters; two matching content/identity samples and no visible loading/risk/login challenge. Do not wait for all resource `load` events. Distinguish offline via `.summary-planes__invalid-text` or trusted message header `is-offline`; offline JD can support interpretation but must not be shown as an active opportunity.

Use existing browser contract for background open, locate the returned new tab by current list and numeric identity, validate same window + unchanged active tabs, wake without focus, verify exact canonical id and selected title/company, read and always close. If create throws after opening, attribute only newly added exact-target same-window tab; stop if cleanup cannot be verified. Recheck selected message after cleanup even when cancelling, without passing an aborted signal to the cleanup verification. Preserve cancellation and original error while prioritizing cleanup errors that leave resources unverified.

Tab ID compatibility clarification: Edge may return a numeric ID as a string on creation while listTabs has its numeric value; after matching use the actual typed ID from listTabs. Keep numeric IDs numeric, but existing CDP string target IDs remain valid. Reuse browser_tab_identity helpers rather than coercing all IDs to one type.

Use existing `createBatch`, `upsertJob`, `retryOneJobAnalysis`, `findMessageDiscoveryJobContext`, `ensureProgressCard`, `bindProgressCardThread` pattern; new batch site is `zhaopin`, keyword/mode `message-discovery-detail`. Check cancellation before each DB mutation and after model await. Recheck the current active plan and selected conversation before binding/processing, so a concurrent plan change cannot use the old plan implicitly.

```js
const batchId = createBatch(db, 'zhaopin', 'message-discovery-detail', 'message discovery detail', {
  profileId, searchPlanId: plan.id,
  filterSnapshot: {mode:'message-discovery-detail', sourceId:detail.sourceId}
});
const jobId = upsertJob(db, {...detail, url:detail.canonicalUrl, keyword:'message-discovery-detail',
  qualityTags:[], analysis:{provider:'message-discovery-detail', semanticStatus:'pending',
    decisionSource:'analysis_pending', recommendation:null, sourceAvailability:detail.availability}}, batchId);
await analyzeJob({db,input:{planId:plan.id,jobId},deps:{root,logger,modelReady:Boolean(modelConfig),modelConfig,
  ...analysisDeps,messageContextAnalysis:true,signal}});
```

`analysis.sourceAvailability` is source evidence, not model output: carry validated `offline`/`unknown` through the existing single-job retry write for ZL only; never take its value from the model. Cache hits may be annotated from the just-revalidated message target without browser detail visits; persist only this source-evidence field with narrow `json_set` updates to the matching observation/current matching job in one SQLite transaction if it changed. Do not rewrite model analysis or score. Projection and sanitizer expose `job.availability`; offline message details say “职位已下线，以下资料用于理解这段沟通”, overriding a misleading current “可投” label without changing the frozen match decision or generating platform actions. Restore uses the saved source metadata. No extra schema.

Add ZL detail fatal codes to the core discovery stop classification so target drift/background/cleanup failures stop the run and retained text survives; incomplete JD/model analysis remain user-readable pending. Platform risk state is recorded for ZL via existing site runtime/access mechanisms and must prevent subsequent ZL starts; keep BOSS runtime state separate. Errors must not leak raw page content/credentials into logs.

- [ ] **Step 3: Verify targeted regressions and integration.**

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:TEMP='D:/DevData/RoleFlow-tests'; $env:TMP=$env:TEMP
D:/hermes/node/node.exe tests/zhaopin_message_reader_smoke.js
D:/hermes/node/node.exe tests/zhaopin_message_detail_reader_smoke.js
D:/hermes/node/node.exe tests/zhaopin_message_job_context_smoke.js
D:/hermes/node/node.exe tests/zhaopin_message_discovery_smoke.js
D:/hermes/node/node.exe tests/message_discovery_job_context_smoke.js
D:/hermes/node/node.exe tests/dashboard_message_discovery_smoke.js
D:/hermes/node/node.exe tests/dashboard_unified_messages_journey.js
git diff --check
```

Test actual callback order and DB outcomes using fake browser/model boundaries; never assert only source-text presence. Include persistence/restart of generated draft and offline status and independent same-id wrong-platform cache. Controller runs final full suite after all plans; avoid redundant full gates here. Known SQLite ExperimentalWarning is baseline, not new regression.

- [ ] **Step 4: Commit and independent review.** Commit only owned code/tests. Record RED/GREEN, covering command/output, commit SHA and outstanding live assumptions. Main then restarts the isolated app and performs real message -> detail -> real model -> saved draft from product UI, stopping before reply send.
