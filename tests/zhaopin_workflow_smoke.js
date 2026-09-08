const assert = require('node:assert/strict');
const { buildScanCliArgs } = require('../src/core/scan_execution');
const { planWorkflowRun } = require('../src/core/workflow_run');
const { ZhaopinSiteAdapter, resolveZhaopinSearchTab } = require('../src/adapters/sites/zhaopin');
const storage = require('../src/core/storage');
const { canonicalizeZhaopinSearchTemplate } = require('../src/core/zhaopin_search_scope');
const { buildWorkflowDashboardState, startPlanScan, resolveLiveAcquisitionContext } = require('../src/dashboard/server');
const { savePlatformSearchContext } = require('../src/storage/platform_search_context_store');
const { buildInheritedSearchScope, freezeKeywordSource } = require('../src/core/inherited_search_scope');
const { compileZhaopinPlatformRuntimePolicy } = require('../src/core/platform_runtime_policy');
const { buildScanExecutionSnapshot } = require('../src/core/scan_snapshot');
const { runWorkflowAnalysisPhase } = require('../src/core/job_analysis');
const { getWorkflowProgressSnapshot } = require('../src/core/workflow_progress');
const { EventEmitter } = require('node:events');
const { matchingCardFromProfile } = require('../src/core/matching_card');
const { requestWorkflowPause, finalizeWorkflowControl, resumeWorkflowRun } = require('../src/core/workflow_control');
const { createSiteAccessController } = require('../src/core/site_access_budget');
const fs = require('node:fs');
const path = require('node:path');

function fakeBrowser({ terminal = true, loadingOnSwitch = false, cardCount = 3, navigateError = null } = {}) {
  let url = 'https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=AI';
  let selectedIndex = 0;
  let windowId = 1;
  let dashboardPath = '/workflow';
  const overrides = {};
  const cards = Array.from({ length: cardCount }, (_, index) => ({ index, signature: `card-${index}`, title: `岗位${index}`, company: '公司', salary: '10-20K', location: '广州' }));
  return {
    setState(value) { Object.assign(overrides, value); },
    moveToWindow(value) { windowId = value; },
    changeDashboardPage(value) { dashboardPath = value; },
    async listTabs() { return [{ id: 'dashboard', windowId: 1, url: `http://127.0.0.1${dashboardPath}`, active: true }, { id: 'cdp-zl', windowId, url, active: false }]; },
    async navigate(id, target) { assert.equal(id, 'cdp-zl'); if (navigateError) throw navigateError; url = target; selectedIndex = 0; },
    async evalValue(id, expression) {
      assert.equal(id, 'cdp-zl');
      if (expression.includes('const clean =')) return true;
      if (expression.includes('__zhaopinActivateCard(')) { selectedIndex = Number(expression.match(/ActivateCard\((\d+)/)[1]); if (loadingOnSwitch) overrides.loading = true; return { ready: true }; }
      if (expression.includes('__zhaopinScrollResults')) return true;
      return { url, keyword: new URL(url).searchParams.get('kw'), filterSummary: ['广东'], cards, selectedIndex, loading: false, risk: false, loginRequired: false, isSearchPage: true, confirmedEnd: terminal,
        detail: { ...cards[selectedIndex], description: '完整岗位职责与任职要求。'.repeat(20), url: `https://www.zhaopin.com/jobdetail/SYNTH${selectedIndex}.htm` }, ...overrides };
    }
  };
}

async function main() {
  for (const analysisOnly of [false, true]) {
    const args = buildScanCliArgs({ site: 'zhaopin', kind: 'daily', dbPath: 'fixture.sqlite', planId: 1, browserMode: 'edge', runId: 'fixture', workflowRunId: analysisOnly ? 'workflow' : '', analysisOnly });
    assert.equal(args[args.indexOf('--site') + 1], 'zhaopin', 'frozen source must reach acquisition and analysis children');
  }
  assert.throws(() => buildScanCliArgs({ site: 'unknown', kind: 'daily', dbPath: 'fixture.sqlite', planId: 1, browserMode: 'edge', runId: 'fixture' }));
  const next = planWorkflowRun({ site: 'zhaopin', successfulToday: 1000, inventoryCount: 1000, keywords: ['AI'] });
  assert.equal(next.scanNeeded, true, 'readonly acquisition must not use communication success or inventory');
  assert.equal(next.targetSuccessCount, 0);
  const restoring = fakeBrowser();
  restoring.setState({ filterSummary: ['默认占位'] });
  const readyAdapter = new ZhaopinSiteAdapter({ browser: restoring, sleepFn: async () => restoring.setState({ filterSummary: ['广东'] }) });
  assert.equal((await readyAdapter.waitForSearchReady('cdp-zl', { searchTemplate: canonicalizeZhaopinSearchTemplate('https://www.zhaopin.com/jobs/?pageMode=search&jl=548'), keyword: 'AI', filterSummary: ['广东'] })).filterSummary[0], '广东', 'restoration must wait out transient placeholder filters');
  for (const windowId of [2, undefined, null, '']) {
    const wrongWindow = fakeBrowser();
    wrongWindow.moveToWindow(windowId);
    await assert.rejects(() => resolveZhaopinSearchTab(wrongWindow), error => error.code === 'ZHAOPIN_WINDOW_MISMATCH');
    await assert.rejects(() => new ZhaopinSiteAdapter({ browser: wrongWindow }).preflight({ tabId: 'cdp-zl' }), error => error.code === 'ZHAOPIN_WINDOW_MISMATCH');
  }
  const db = storage.openDb(':memory:');
  try {
    const batch = storage.createBatch(db, 'zhaopin', 'AI', 'synthetic');
    const bossBatch = storage.createBatch(db, 'boss', 'AI', 'synthetic');
    storage.upsertJob(db, { source: 'boss', sourceId: 'SYNTH0', title: 'BOSS岗位', description: 'BOSS JD' }, bossBatch);
    const targets = [];
    const adapter = new ZhaopinSiteAdapter({ browser: fakeBrowser(), sleepFn: async () => {}, randomFn: () => 0 });
    assert.equal(typeof adapter.scan, 'function', 'readonly adapter must support the shared scan/checkpoint contract');
    const opts = { tabId: 'cdp-zl', keywords: ['AI'], keywordPlan: [{ word: 'AI', priority: 'A' }], searchTemplate: canonicalizeZhaopinSearchTemplate('https://www.zhaopin.com/jobs/?pageMode=search&jl=548'), filterSummary: ['广东'], maxCards: 3, maxDetailTotal: 1, browserPageBudget: 1,
      onDetailCheckpoint: ({ job }) => storage.upsertJob(db, job, batch), onTargetComplete: result => targets.push(result) };
    const routeBridge = fakeBrowser();
    const routeBatch = storage.createBatch(db, 'zhaopin', 'AI', 'same-window-pages');
    const routeTargets = [], dashboardPages = ['/jobs', '/settings', '/onboarding'];
    let routeCheckpoints = 0;
    const routeJobs = await new ZhaopinSiteAdapter({ browser: routeBridge, sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...opts, maxDetailTotal: 3,
      onDetailCheckpoint: ({ job }) => { storage.upsertJob(db, job, routeBatch); routeBridge.changeDashboardPage(dashboardPages[routeCheckpoints++]); },
      onTargetComplete: target => routeTargets.push(target)
    });
    assert.equal(routeJobs.length, 3, 'same-window Dashboard navigation must not interrupt actual scanning');
    assert.equal(storage.listReportJobs(db, { batchId: routeBatch }).length, 3);
    assert.equal(routeTargets[0].status, 'completed');
    await adapter.scan(opts);
    assert.equal(storage.listReportJobs(db, { batchId: batch }).length, 1, 'detail is durable before proceeding to another card');
    assert.equal(storage.listReportJobs(db, { batchId: bossBatch })[0].title, 'BOSS岗位');
    assert.equal(targets[0].status, 'partial', 'detail budget exhaustion cannot finish a logical target');
    const sameBudgetJobs = new Map(storage.listReportJobs(db, { batchId: batch }).map(job => [job.sourceId, job]));
    await adapter.scan({ ...opts, getReusableDetail: job => sameBudgetJobs.get(job.sourceId) });
    assert.equal(storage.listReportJobs(db, { batchId: batch }).length, 2, 'resuming the same frozen detail budget must advance beyond already saved jobs');
    for (const changed of [{ description: '发生实质变化的职责'.repeat(40) }, { clientCompany: '另一个客户公司' }, { source: 'boss' }]) {
      const outcomes = [];
      const changedCache = { ...sameBudgetJobs.get('SYNTH0'), ...changed };
      const read = await adapter.scan({ ...opts, getReusableDetail: () => changedCache, onDetailResult: result => outcomes.push(result) });
      assert.equal(read.length, 1, 'changed content or a wrong-source cache consumes the new-JD limit before another card');
      assert.equal(read[0].sourceId, 'SYNTH0');
      assert.equal(outcomes[0].outcome, 'succeeded');
      assert.equal(outcomes[0].reused, false);
    }
    targets.length = 0;
    await adapter.scan({ ...opts, maxDetailTotal: 3 });
    assert.equal(storage.listReportJobs(db, { batchId: batch }).length, 3);
    assert.equal(targets[0].status, 'completed');
    assert.equal(targets[0].details.stopReason, 'card_limit_reached');
    const controller = new AbortController();
    let durable = 0;
    await assert.rejects(() => adapter.scan({ ...opts, maxDetailTotal: 3, signal: controller.signal, onDetailCheckpoint: ({ job }) => { storage.upsertJob(db, job, batch); durable++; controller.abort(); } }), error => error.code === 'ZHAOPIN_ABORTED');
    assert.equal(durable, 1, 'stop after checkpoint must prevent reading the next job');
    const noGrowth = [];
    await new ZhaopinSiteAdapter({ browser: fakeBrowser({ terminal: false }), sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...opts, maxCards: 4, maxDetailTotal: 4, onTargetComplete: target => noGrowth.push(target) });
    assert.equal(noGrowth[0].status, 'partial');
    assert.equal(noGrowth[0].details.stopReason, 'scroll_limit', 'no growth is not evidence of list end');
    for (const [changed, errorCode] of [[{ risk: true }, 'ZHAOPIN_RISK_CONTROL'], [{ isSearchPage: false }, 'ZHAOPIN_SEARCH_PAGE_LOST'], [{ filterSummary: ['条件改变'] }, 'ZHAOPIN_SEARCH_SCOPE_CHANGED']]) {
      const bridge = fakeBrowser();
      let checked = 0;
      await assert.rejects(() => new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...opts, maxDetailTotal: 3, onDetailCheckpoint: ({ job }) => { storage.upsertJob(db, job, batch); checked++; bridge.setState(changed); } }), error => error.code === errorCode);
      assert.equal(checked, 1, `${errorCode} stops before the next job`);
    }
    const incomplete = fakeBrowser();
    incomplete.setState({ detail: { title: '岗位0', company: '公司', salary: '10-20K', location: '广州', description: '短描述', url: 'https://www.zhaopin.com/jobdetail/SYNTH0.htm' } });
    await assert.rejects(() => new ZhaopinSiteAdapter({ browser: incomplete, sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...opts }), error => error.code === 'ZHAOPIN_DETAIL_INCOMPLETE');
    const loadingBatch = storage.createBatch(db, 'zhaopin', 'AI', 'loading-timeout');
    const loadingTargets = [], loadingTerminal = [];
    const loadingBridge = fakeBrowser({ loadingOnSwitch: true });
    let waits = 0;
    await assert.rejects(() => new ZhaopinSiteAdapter({ browser: loadingBridge, sleepFn: async () => { waits++; }, randomFn: () => 0 }).scan({ ...opts, maxDetailTotal: 3,
      onDetailCheckpoint: ({ job }) => storage.upsertJob(db, job, loadingBatch), onTargetComplete: target => loadingTargets.push(target), onScanComplete: result => loadingTerminal.push(result)
    }), error => error.code === 'ZHAOPIN_DETAIL_IDENTITY_UNCONFIRMED');
    assert.deepEqual(storage.listReportJobs(db, { batchId: loadingBatch }).map(job => job.sourceId), ['SYNTH0'], 'new ID must not adopt a still-loading old complete body');
    assert.equal(loadingTargets[0].status, 'partial');
    assert.equal(loadingTerminal[0].status, 'partial');
    assert(waits < 100, 'detail readiness wait is bounded');
    const loadingStop = new AbortController();
    const stopBridge = fakeBrowser({ loadingOnSwitch: true });
    const stopAdapter = new ZhaopinSiteAdapter({ browser: stopBridge, sleepFn: async () => loadingStop.abort() });
    const stopState = await stopAdapter.readSearchState('cdp-zl');
    await assert.rejects(() => stopAdapter.readVisiblePaneDetail('cdp-zl', stopState.cards[1], loadingStop.signal), error => error.code === 'ZHAOPIN_ABORTED');
    const moved = fakeBrowser(), movedTargets = [];
    const movedBatch = storage.createBatch(db, 'zhaopin', 'AI', 'window-moved');
    await assert.rejects(() => new ZhaopinSiteAdapter({ browser: moved, sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...opts, maxDetailTotal: 3,
      onDetailCheckpoint: ({ job }) => { storage.upsertJob(db, job, movedBatch); moved.moveToWindow(2); }, onTargetComplete: target => movedTargets.push(target)
    }), error => error.code === 'ZHAOPIN_WINDOW_MISMATCH');
    assert.deepEqual(storage.listReportJobs(db, { batchId: movedBatch }).map(job => job.sourceId), ['SYNTH0']);
    assert.equal(movedTargets[0].status, 'partial', 'moving windows preserves the checkpoint and unfinished target');
  } finally { db.close(); }
  await scanCheckpointContractSmoke();
  const flowDb = storage.openDb(':memory:');
  try {
    const saved = storage.saveProfileAnalysis(flowDb, { profile: { candidate: { name: '合成候选人', city: '广州', targetTitles: ['AI'] }, skills: [], projects: [] }, document: { originalFileName: 'test.txt', format: 'text', contentHash: 'workflow-synthetic', text: '合成简历', diagnostics: {} }, searchPlan: { name: '合成方案', cities: ['广州'], keywords: [{ word: 'AI', priority: 'A' }] } });
    const plan = storage.getSearchPlan(flowDb, saved.planId);
    const rescoreBatch = storage.createBatch(flowDb, 'zhaopin', 'AI', 'rescore-synthetic', { profileId: saved.profileId, searchPlanId: plan.id });
    const rescoreJob = { source: 'zhaopin', sourceId: 'CLIENT', title: 'AI开发', company: '发布方', clientCompany: '客户公司', salary: '10-20K', experience: '', education: '', location: '广州', tags: [], description: '合成完整职责'.repeat(40), analysis: { semanticStatus: 'complete', provider: 'synthetic' } };
    storage.upsertJob(flowDb, rescoreJob, rescoreBatch);
    const rescoreConfig = require('../src/config').loadConfigs(path.resolve(__dirname, '..'));
    rescoreConfig.platformPolicy = { site: 'boss', filters: { location: { districts: ['海淀区'] } } };
    require('../src/storage/job_store').rescorePlanObservations(flowDb, { planId: plan.id, configs: rescoreConfig });
    const rescored = storage.listReportJobs(flowDb, { batchId: rescoreBatch })[0];
    assert.equal(rescored.analysis.expectedRevision.sourceContentHash, require('../src/storage/job_store').sourceContentHash(rescoreJob), 'rescore must include the client-company evidence in the source revision');
    assert.equal(rescored.qualityTags.includes('platform_district_mismatch'), false, 'BOSS native acquisition conditions cannot reject ZL observations');
    const lateBossBatch = storage.createBatch(flowDb, 'boss', 'AI', 'late-boss', { profileId: saved.profileId, searchPlanId: plan.id });
    storage.upsertJob(flowDb, { ...rescoreJob, source: 'boss', title: 'later BOSS row' }, lateBossBatch);
    assert.equal(storage.listReportJobs(flowDb, { planId: plan.id, batch: 'all', site: 'zhaopin', limit: 1 })[0].source, 'zhaopin', 'SQL source filtering must precede LIMIT');
    assert(storage.listDecisionPool(flowDb, { planId: plan.id, site: 'boss' }).every(job => job.source === 'boss'));
    assert.throws(() => storage.listReportJobs(flowDb, { planId: plan.id, site: 'unsupported' }), error => error.code === 'UNKNOWN_SITE');
    const day = '2026-09-06';
    storage.createWorkflowRun(flowDb, { id: 'boss-done', profileId: saved.profileId, planId: saved.planId, site: 'boss', localDay: day, sequence: 1, successfulCount: 100 });
    flowDb.prepare("UPDATE workflow_runs SET status='completed' WHERE id='boss-done'").run();
    const zlState = buildWorkflowDashboardState(flowDb, plan, new Date('2026-09-06T05:00:00Z'), { site: 'zhaopin' });
    assert.equal(zlState.runs.length, 0);
    assert.equal(zlState.nextPlan.scanNeeded, true);
    assert.equal(buildWorkflowDashboardState(flowDb, plan, new Date('2026-09-06T05:00:00Z'), { site: 'boss' }).nextPlan.errorCode, 'WORKFLOW_DAILY_TARGET_REACHED');
    const contextInput = { site: 'zhaopin', db: flowDb, plan, matchingContext: { matchingCard: matchingCardFromProfile({ candidate: { name: '合成' } }) }, logger: { info() {} }, browserFactory: () => fakeBrowser() };
    await assert.rejects(() => resolveLiveAcquisitionContext(contextInput), error => error.code === 'ZHAOPIN_SEARCH_CONTEXT_REQUIRED');
    savePlatformSearchContext(flowDb, { planId: plan.id, site: 'zhaopin', searchTemplate: canonicalizeZhaopinSearchTemplate('https://www.zhaopin.com/jobs/?pageMode=search&jl=548'), filterSummary: ['广东'] });
    storage.setSiteRuntimeState(flowDb, 'zhaopin', { status: 'blocked', reasonCode: 'ZHAOPIN_RISK_CONTROL', details: { blockedUntil: new Date(Date.now() + 60000).toISOString() } });
    await assert.rejects(() => resolveLiveAcquisitionContext(contextInput), error => error.code === 'ZHAOPIN_RISK_CONTROL', 'ZL start must honor its own risk cooldown');
    assert.equal(require('../src/core/communication_runtime').scanRuntimeBlock(flowDb), null, 'ZL cooldown must not become a BOSS cooldown');
    storage.clearSiteRuntimeState(flowDb, 'zhaopin');
    const context = await resolveLiveAcquisitionContext(contextInput);
    assert.equal(context.searchScope.site, 'zhaopin');
    const workflow = storage.createWorkflowRun(flowDb, { id: 'zl-round', profileId: saved.profileId, planId: plan.id, site: 'zhaopin', localDay: day, sequence: 1, keywords: [{ word: 'AI', priority: 'A', maxCards: 3 }], budget: { maxDetailTotal: 3, browserPageBudget: 1 }, planner: { ...context, site: 'zhaopin', browserMode: 'edge', cdpPort: null } });
    storage.transitionWorkflowRun(flowDb, { id: workflow.id, status: 'scanning' });
    const wrongBatch = storage.createBatch(flowDb, 'boss', 'AI', 'wrong-source', { profileId: saved.profileId, searchPlanId: plan.id });
    storage.beginScanRun(flowDb, { runId: 'wrong-source', site: 'boss', command: 'scan', planId: plan.id, batchId: wrongBatch });
    assert.throws(() => storage.attachWorkflowScan(flowDb, { id: workflow.id, scanRunId: 'wrong-source', scanBatchId: wrongBatch }), error => error.code === 'WORKFLOW_SCAN_LINK_MISMATCH', 'same-plan BOSS run must not attach to ZL workflow');
    storage.finishScanRun(flowDb, { runId: 'wrong-source', status: 'completed' });
    const children = [];
    startPlanScan(new Map(), { db: flowDb, root: require('node:path').resolve(__dirname, '..'), dbPath: 'synthetic.sqlite', planId: plan.id, workflowRunId: workflow.id, logger: { info() {}, warn() {}, error() {} }, spawnProcess: (_exe, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); children.push(args); return child; } });
    assert.equal(children[0][children[0].indexOf('--site') + 1], 'zhaopin');
    assert.equal(storage.getLatestScanRun(flowDb, { planId: plan.id, site: 'zhaopin' }).site, 'zhaopin');
    const snapshot = buildScanExecutionSnapshot({ ...context, site: 'zhaopin', keywordPlan: workflow.keywords, limits: { maxCards: 3 } });
    const batchId = storage.createBatch(flowDb, 'zhaopin', 'AI', 'synthetic', { profileId: saved.profileId, searchPlanId: plan.id, filterSnapshot: { execution: snapshot } });
    const scanRun = storage.getLatestScanRun(flowDb, { planId: plan.id, site: 'zhaopin' });
    storage.beginScanRun(flowDb, { runId: scanRun.id, batchId });
    storage.attachWorkflowScan(flowDb, { id: workflow.id, scanRunId: scanRun.id, scanBatchId: batchId });
    const phaseInput = { workflowRun: storage.getWorkflowRun(flowDb, workflow.id), batchId, jobsToAnalyze: [], modelRuntimes: { primary: { revision: 'synthetic', concurrency: 1 } }, createAnalyzeJob: () => async () => { throw new Error('empty synthetic analysis cannot call model'); } };
    await runWorkflowAnalysisPhase(flowDb, phaseInput);
    assert.notEqual(storage.getWorkflowRun(flowDb, workflow.id).status, 'completed', 'an empty analysis queue cannot finish pending targets');
    storage.recordScanTargetResult(flowDb, { batchId, ...snapshot.targets[0], status: 'completed', jobCount: 0, details: { stopReason: 'confirmed_end' } });
    await runWorkflowAnalysisPhase(flowDb, { ...phaseInput, workflowRun: storage.getWorkflowRun(flowDb, workflow.id) });
    assert.equal(storage.getWorkflowRun(flowDb, workflow.id).status, 'completed');
    assert.equal(getWorkflowProgressSnapshot(flowDb, { workflowRunId: workflow.id }).progress.stage, '查看只读结果');
    assert.equal(flowDb.prepare('SELECT COUNT(*) AS n FROM communication_batches').get().n, 0);
    const readonlyInterrupted = storage.createWorkflowRun(flowDb, { id: 'zl-interrupted', site: 'zhaopin', profileId: saved.profileId, planId: plan.id, localDay: require('../src/core/workflow_run').chinaLocalDay(), sequence: 2, inventoryCount: 9 });
    storage.transitionWorkflowRun(flowDb, { id: readonlyInterrupted.id, status: 'interrupted' });
    require('../src/core/workflow_inventory').reconcilePlanWorkflowInventory(flowDb, plan.id);
    assert.equal(storage.getWorkflowRun(flowDb, readonlyInterrupted.id).inventoryCount, 9, 'BOSS inventory reconciliation must not mutate ZL workflow metrics');
  } finally { flowDb.close(); }
  await durableResume();
  console.log('zhaopin_workflow_smoke ok');
}

async function scanCheckpointContractSmoke() {
  const db = storage.openDb(':memory:');
  const searchTemplate = canonicalizeZhaopinSearchTemplate('https://www.zhaopin.com/jobs/?pageMode=search&jl=548');
  const keywordPlan = [
    { word: '第一目标', priority: 'A', maxCards: 3 },
    { word: '第二目标', priority: 'A', maxCards: 3 },
    { word: '第三目标', priority: 'A', maxCards: 2 }
  ];
  const snapshot = buildScanExecutionSnapshot({ site: 'zhaopin', searchTemplate, keywordPlan, limits: { maxCards: 3 } });
  const thirdTargetKey = snapshot.targets[2].targetKey;
  const base = { tabId: 'cdp-zl', keywordPlan, searchTemplate, filterSummary: ['广东'], maxCards: 3, maxDetailTotal: 10, browserPageBudget: 3, targetKeys: [thirdTargetKey] };
  let sequence = 0;
  const withRun = async (label, run, execution = snapshot) => {
    const owner = `checkpoint-${++sequence}-${label}`;
    storage.acquireSiteScanLease(db, { site: 'zhaopin', owner, command: 'scan' });
    storage.beginScanRun(db, { runId: owner, site: 'zhaopin', leaseOwner: owner, command: 'scan' });
    const batchId = storage.createAndBindScanBatch(db, { runId: owner, leaseOwner: owner, site: 'zhaopin', keyword: label, filterSnapshot: { execution } });
    let checkpointError = null;
    const checkpointProgress = (result) => {
      try {
        const { jobs = [], ...scanProgress } = result;
        storage.checkpointScanProgress(db, { runId: owner, batchId, leaseOwner: owner, jobs, runtime: { scanProgress: { version: 1, ...scanProgress, updatedAt: new Date().toISOString() } } });
      } catch (error) { checkpointError = error; throw error; }
    };
    const checkpointTarget = (result) => {
      try {
        storage.checkpointScanTarget(db, {
          runId: owner,
          batchId,
          leaseOwner: owner,
          target: result,
          jobs: result.jobs,
          runtime: { scanProgress: { version: 1, activity: 'target_complete', targetKey: result.targetKey, targetPosition: result.targetPosition, targetTotal: result.targetTotal, targetDiscovered: result.targetDiscovered, detailPosition: result.detailPosition, detailTotal: result.detailTotal, updatedAt: new Date().toISOString() } }
        });
      } catch (error) { checkpointError = error; throw error; }
    };
    const checkpointDetail = ({ job }) => storage.checkpointScanProgress(db, { runId: owner, batchId, leaseOwner: owner, jobs: [job] });
    try {
      await run({ owner, batchId, checkpointProgress, checkpointTarget, checkpointDetail });
      assert.equal(checkpointError, null, `${label} must not produce SCAN_PROGRESS_INVALID`);
      return batchId;
    } finally {
      const active = storage.getScanRun(db, owner);
      if (active?.status === 'running') storage.finishScanRun(db, { runId: owner, leaseOwner: owner, status: 'interrupted' });
      storage.releaseSiteScanLease(db, { site: 'zhaopin', owner });
    }
  };

  try {
    const navigationFailure = Object.assign(new Error('synthetic navigation failure'), { code: 'ZHAOPIN_NAVIGATION_FAILED' });
    const navigationBatchId = await withRun('navigation-failure', async ({ checkpointTarget }) => {
      await assert.rejects(() => new ZhaopinSiteAdapter({ browser: fakeBrowser({ navigateError: navigationFailure }), sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...base, targetKeys: [snapshot.targets[0].targetKey], onTargetComplete: checkpointTarget }), (error) => error === navigationFailure);
    });
    const navigationProgress = storage.getBatch(db, navigationBatchId).filterSnapshot.runtime.scanProgress;
    assert.deepEqual({ targetPosition: navigationProgress.targetPosition, targetTotal: navigationProgress.targetTotal, targetDiscovered: navigationProgress.targetDiscovered, detailPosition: navigationProgress.detailPosition, detailTotal: navigationProgress.detailTotal },
      { targetPosition: 1, targetTotal: 3, targetDiscovered: 0, detailPosition: 0, detailTotal: 0 });

    await withRun('detail-then-failure', async ({ batchId, checkpointTarget, checkpointDetail }) => {
      const bridge = fakeBrowser({ cardCount: 4 });
      await assert.rejects(() => new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => {}, randomFn: () => 0 }).scan({
        ...base,
        onDetailCheckpoint: (result) => { checkpointDetail(result); bridge.setState({ risk: true }); },
        onTargetComplete: checkpointTarget
      }), (error) => error.code === 'ZHAOPIN_RISK_CONTROL');
      assert.equal(storage.listReportJobs(db, { batchId }).length, 1, 'a later target failure must not delete the independently committed JD');
    });

    const completedBatchId = await withRun('card-limit', async ({ checkpointTarget, checkpointDetail }) => {
      await new ZhaopinSiteAdapter({ browser: fakeBrowser({ cardCount: 4 }), sleepFn: async () => {}, randomFn: () => 0 }).scan({ ...base, onDetailCheckpoint: checkpointDetail, onTargetComplete: checkpointTarget });
    });
    const completedProgress = storage.getBatch(db, completedBatchId).filterSnapshot.runtime.scanProgress;
    assert.deepEqual({ targetPosition: completedProgress.targetPosition, targetTotal: completedProgress.targetTotal, targetDiscovered: completedProgress.targetDiscovered, detailPosition: completedProgress.detailPosition, detailTotal: completedProgress.detailTotal },
      { targetPosition: 3, targetTotal: 3, targetDiscovered: 3, detailPosition: 3, detailTotal: 3 }, 'cardLimit bounds counters without hiding saved jobs');

    let pauseRequested = false;
    const scrollSnapshot = buildScanExecutionSnapshot({ site: 'zhaopin', searchTemplate, keywordPlan, limits: { maxCards: 4 } });
    const pausedBatchId = await withRun('scroll-pause', async ({ checkpointProgress, checkpointDetail }) => {
      const assertControl = () => { if (pauseRequested) throw Object.assign(new Error('pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' }); };
      const bridge = fakeBrowser({ terminal: false });
      const focusStates = [];
      let focusEnabled = false;
      const cleanupTransportCause = Object.assign(new Error('cleanup transport disconnected'), { code: 'BROWSER_DISCONNECTED' });
      const cleanupFailure = Object.assign(new Error('scan focus cleanup failed'), { code: 'BROWSER_COMMAND_FAILED', cause: cleanupTransportCause });
      bridge.setPageLifecycleActive = async () => {};
      bridge.cdp = async (_tabId, method, params) => {
        assert.equal(method, 'Emulation.setFocusEmulationEnabled');
        focusEnabled = params.enabled;
        focusStates.push(params.enabled);
        if (!params.enabled) throw cleanupFailure;
      };
      await assert.rejects(() => new ZhaopinSiteAdapter({ browser: bridge, sleepFn: async () => {}, randomFn: () => 0 }).scan({
        ...base,
        keywordPlan: keywordPlan.map((item, index) => index === 2 ? { ...item, maxCards: 4 } : item),
        maxCards: 4,
        assertTabBindings: assertControl,
        onDetailCheckpoint: checkpointDetail,
        onProgressCheckpoint: (result) => {
          checkpointProgress(result);
          if (result.activity === 'searching') {
            assert.equal(focusEnabled, true, 'background rendering remains enabled while scrolling for newly rendered cards');
            pauseRequested = true;
          }
        }
      }), (error) => {
        assert.equal(error.code, 'BROWSER_COMMAND_FAILED', 'scan cleanup failure remains the outward error');
        assert.equal(error.cause?.code, 'WORKFLOW_PAUSE_REQUESTED', 'scan pause remains available as the primary cause');
        assert.deepEqual(error.errors, [cleanupFailure, error.cause]);
        assert.equal(cleanupFailure.cause, cleanupTransportCause, 'scan cleanup transport cause is preserved');
        return true;
      });
      assert.deepEqual(focusStates, [true, false], 'the target-wide background rendering scope is released exactly once after pause');
    }, scrollSnapshot);
    const pausedProgress = storage.getBatch(db, pausedBatchId).filterSnapshot.runtime.scanProgress;
    assert.equal(pausedProgress.activity, 'searching');
    assert.deepEqual({ targetPosition: pausedProgress.targetPosition, targetTotal: pausedProgress.targetTotal, targetDiscovered: pausedProgress.targetDiscovered, detailPosition: pausedProgress.detailPosition, detailTotal: pausedProgress.detailTotal },
      { targetPosition: 3, targetTotal: 3, targetDiscovered: 3, detailPosition: 3, detailTotal: 3 });
  } finally { db.close(); }
}

async function durableResume() {
  const runtime = path.resolve(__dirname, '../.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const dir = fs.mkdtempSync(path.join(runtime, 'zhaopin-workflow-'));
  const filename = path.join(dir, 'fixture.sqlite');
  let db = storage.openDb(filename);
  try {
    const saved = storage.saveProfileAnalysis(db, { profile: { candidate: { name: '恢复合成候选人', city: '广州', targetTitles: ['AI应用开发'] } }, document: { originalFileName: 'fixture.txt', format: 'text', contentHash: 'synthetic-resume', text: '合成简历', diagnostics: {} }, searchPlan: { name: '恢复', cities: ['广州'], directions: ['AI应用开发'], keywords: [{ word: 'AI', priority: 'A' }, { word: '工程', priority: 'A' }] } });
    const scope = buildInheritedSearchScope({ site: 'zhaopin', profileId: saved.profileId, rawUrl: 'https://www.zhaopin.com/jobs/?pageMode=search&jl=548' });
    const keywords = [{ word: 'AI', priority: 'A', maxCards: 3 }, { word: '工程', priority: 'A', maxCards: 3 }];
    const acquisition = { site: 'zhaopin', ...scope, acquisitionMode: 'inherited', browserMode: 'edge', cdpPort: null,
      keywordSource: freezeKeywordSource({ planRecord: storage.getSearchPlan(db, saved.planId), matchingCardRevision: 'synthetic-matching' }), platformPolicy: compileZhaopinPlatformRuntimePolicy({ searchScope: scope.searchScope, filterSummary: ['广东'] }) };
    const snapshot = buildScanExecutionSnapshot({ ...acquisition, keywordPlan: keywords, limits: { maxCards: 3 } });
    const workflow = storage.createWorkflowRun(db, { site: 'zhaopin', profileId: saved.profileId, planId: saved.planId, localDay: require('../src/core/workflow_run').chinaLocalDay(), sequence: 1, keywords, planner: acquisition });
    storage.transitionWorkflowRun(db, { id: workflow.id, status: 'scanning' });
    storage.acquireSiteScanLease(db, { site: 'zhaopin', owner: 'first', planId: saved.planId, command: 'scan' });
    assert.throws(() => storage.acquireSiteScanLease(db, { site: 'boss', owner: 'competing', planId: saved.planId, command: 'scan' }), error => /LEASE|RUNNING/.test(error.code));
    storage.beginScanRun(db, { runId: 'first', site: 'zhaopin', planId: saved.planId, leaseOwner: 'first', command: 'scan' });
    const batchId = storage.createAndBindScanBatch(db, { runId: 'first', leaseOwner: 'first', site: 'zhaopin', keyword: 'AI,工程', profileId: saved.profileId, searchPlanId: saved.planId, filterSnapshot: { execution: snapshot } });
    storage.attachWorkflowScan(db, { id: workflow.id, scanRunId: 'first', scanBatchId: batchId });
    const assertControl = () => { if (storage.getWorkflowRun(db, workflow.id).controlState === 'pause_requested') throw Object.assign(new Error('pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' }); };
    const base = { tabId: 'cdp-zl', keywordPlan: keywords, ...scope, filterSummary: ['广东'], maxCards: 3, maxDetailTotal: 1, browserPageBudget: 2, assertTabBindings: assertControl };
    const first = new ZhaopinSiteAdapter({ browser: fakeBrowser(), sleepFn: async () => {}, randomFn: () => 0, accessController: createSiteAccessController({ db, site: 'zhaopin', runId: 'first' }) });
    await assert.rejects(() => first.scan({ ...base, onDetailCheckpoint: ({ job }) => {
      storage.checkpointScanProgress(db, { runId: 'first', batchId, leaseOwner: 'first', jobs: [job] });
      requestWorkflowPause(db, { workflowRunId: workflow.id, now: new Date().toISOString() });
    } }), error => error.code === 'WORKFLOW_PAUSE_REQUESTED');
    storage.finishScanRun(db, { runId: 'first', leaseOwner: 'first', status: 'interrupted' });
    finalizeWorkflowControl(db, { workflowRunId: workflow.id, now: new Date().toISOString() });
    storage.releaseSiteScanLease(db, { site: 'zhaopin', owner: 'first' });
    assert.equal(storage.getWorkflowRun(db, workflow.id).status, 'paused');
    db.close();
    db = storage.openDb(filename);
    assert.equal(storage.listReportJobs(db, { batchId }).length, 1);
    assert.equal(storage.getWorkflowRun(db, workflow.id).planner.searchScope.templateUrl, scope.searchScope.templateUrl);
    const movedBrowser = fakeBrowser();
    movedBrowser.moveToWindow(2);
    let spawnedWhileMoved = 0;
    const resumeServer = require('../src/dashboard/server').createDashboardServer({ db, root: path.resolve(__dirname, '..'), dataRoot: dir, dbPath: filename,
      browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' }, forceMock: true, allowOfflineMock: true,
      logger: { info() {}, warn() {}, error() {}, requestId() { return 'moved-resume'; }, listRecent() { return []; } },
      browserFactory: () => movedBrowser, spawnProcess: () => { spawnedWhileMoved++; throw new Error('cross-window resume issued a child'); }
    });
    try {
      await new Promise(resolve => resumeServer.listen(0, '127.0.0.1', resolve));
      for (const route of ['/api/workflow-control', '/api/workflow-run/resume']) {
        const response = await fetch(`http://127.0.0.1:${resumeServer.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowRunId: workflow.id, action: 'resume' }), redirect: 'manual' });
        const body = await response.text();
        assert.equal(response.status, route === '/api/workflow-control' ? 409 : 400, body);
        assert.match(body, /ZHAOPIN_WINDOW_MISMATCH/);
        assert.equal(storage.getWorkflowRun(db, workflow.id).status, 'paused');
        assert.equal(storage.listReportJobs(db, { batchId }).length, 1);
      }
      assert.equal(spawnedWhileMoved, 0, 'both scan-bearing HTTP resume paths stop before launching the next operation');
    } finally { await new Promise(resolve => resumeServer.close(resolve)); }
    resumeWorkflowRun(db, { workflowRunId: workflow.id, now: new Date().toISOString() });
    for (const [owner, expectedJobs, expectedVisits] of [['second', 2, 2], ['third', 3, 3], ['fourth', 3, 3]]) {
      if (owner !== 'second') storage.transitionWorkflowRun(db, { id: workflow.id, status: 'scanning' });
      storage.acquireSiteScanLease(db, { site: 'zhaopin', owner, planId: saved.planId, command: 'scan' });
      storage.beginScanRun(db, { runId: owner, site: 'zhaopin', planId: saved.planId, leaseOwner: owner, command: 'scan', batchId });
      storage.attachWorkflowScan(db, { id: workflow.id, scanRunId: owner, scanBatchId: batchId });
      const cache = new Map(storage.listReusableJobDetails(db, { site: 'zhaopin', profileId: saved.profileId }).map(job => [job.sourceId, job]));
      const resumed = new ZhaopinSiteAdapter({ browser: fakeBrowser(), sleepFn: async () => {}, randomFn: () => 0, accessController: createSiteAccessController({ db, site: 'zhaopin', runId: owner }) });
      const targetKeys = require('../src/core/scan_snapshot').remainingTargetKeys(snapshot, storage.listLatestScanTargetResults(db, batchId));
      await resumed.scan({ ...base, targetKeys, getReusableDetail: job => cache.get(job.sourceId), onDetailCheckpoint: ({ job }) => storage.checkpointScanProgress(db, { runId: owner, batchId, leaseOwner: owner, jobs: [job] }), onTargetComplete: target => storage.checkpointScanTarget(db, { runId: owner, batchId, leaseOwner: owner, target, jobs: target.jobs }) });
      assert.equal(storage.listReportJobs(db, { batchId }).length, expectedJobs, 'the same frozen one-new-JD budget must advance after DB reopen');
      const visits = storage.listSiteAccessEvents(db, { site: 'zhaopin' }).filter(event => event.action === 'pane_detail_read' && event.details.runId === owner);
      assert.equal(visits.length, expectedVisits, 'reused pane visits remain in the physical access ledger and no extra card is visited after the new-JD limit');
      storage.finishScanRun(db, { runId: owner, leaseOwner: owner, status: owner === 'fourth' ? 'completed' : 'partial' });
      storage.releaseSiteScanLease(db, { site: 'zhaopin', owner });
      if (owner !== 'fourth') {
        storage.transitionWorkflowRun(db, { id: workflow.id, status: 'interrupted', resumePhase: 'scanning' });
        db.close();
        db = storage.openDb(filename);
      }
    }
    assert.equal(storage.listLatestScanTargetResults(db, batchId).filter(item => item.status === 'completed').length, 2);
    const jobs = storage.listReportJobs(db, { batchId });
    const analysis = await runWorkflowAnalysisPhase(db, { workflowRun: storage.getWorkflowRun(db, workflow.id), batchId, jobsToAnalyze: jobs, modelRuntimes: { primary: { revision: 'synthetic', concurrency: 1, modelConfig: { provider: 'mock', model: 'synthetic' } } }, createAnalyzeJob: () => async job => ({ ...job, analysis: { provider: 'synthetic', semanticStatus: 'complete', recommendation: 'apply', decisionStatus: 'decided', evidence: { jd: ['synthetic JD'], resume: ['synthetic resume'] } } }) });
    assert.equal(storage.getWorkflowRun(db, workflow.id).status, 'completed', JSON.stringify({ analysis, targets: storage.listLatestScanTargetResults(db, batchId), workflow: storage.getWorkflowRun(db, workflow.id) }));
    assert.equal(storage.listReportJobs(db, { batchId }).length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM communication_batches').get().n, 0);
    assert(storage.listSiteAccessEvents(db, { site: 'zhaopin' }).length >= 2);
    assert.equal(storage.listSiteAccessEvents(db, { site: 'boss' }).length, 0);
    await productionCliScan(db, { saved, scope, dir });
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function productionCliScan(db, { saved, scope, dir }) {
  const profile = storage.getCandidateProfile(db, saved.profileId);
  const draft = storage.createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId, resumeContentHash: 'synthetic-resume', card: matchingCardFromProfile(profile.profile), source: 'migration' });
  storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
  const plan = storage.getSearchPlan(db, saved.planId);
  const matching = storage.getCandidateMatchingContext(db, saved.profileId);
  const context = { ...scope, acquisitionMode: 'inherited', site: 'zhaopin', keywordSource: freezeKeywordSource({ planRecord: plan, matchingCardRevision: require('../src/core/matching_card').matchingCardRevision(matching.matchingCard) }), platformPolicy: compileZhaopinPlatformRuntimePolicy({ searchScope: scope.searchScope, filterSummary: ['广东'] }) };
  const workflow = storage.createWorkflowRun(db, { profileId: saved.profileId, planId: saved.planId, site: 'zhaopin', localDay: require('../src/core/workflow_run').chinaLocalDay(), sequence: 2, keywords: [{ word: 'AI', priority: 'A', maxCards: 3 }], budget: { maxDetailTotal: 3, browserPageBudget: 1 }, planner: { ...context, browserMode: 'edge', cdpPort: null } });
  storage.transitionWorkflowRun(db, { id: workflow.id, status: 'scanning' });
  const settings = require('../src/core/model_settings');
  const mockConfig = { provider: 'mock', providers: { mock: { model: 'offline-structured-mock' } } };
  await settings.saveVerifiedModelTaskProfile({ root: dir, taskProfile: 'batch_screening', fallbackModelConfig: mockConfig, input: { preset: 'mock', model: 'offline-structured-mock' } });
  const runtime = settings.resolveRuntimeModelConfig({ root: dir, taskProfile: 'batch_screening', fallbackModelConfig: mockConfig });
  assert.equal(settings.isModelReady(runtime, { taskProfile: 'batch_screening' }), true);
  const factory = require('../src/adapters/sites');
  const originalFactory = factory.createSiteAdapter;
  const reports = require('../src/reports/render');
  const originalRender = reports.renderReports;
  reports.renderReports = jobs => originalRender(jobs, path.join(dir, 'reports'));
  const pacingWaits = [];
  factory.createSiteAdapter = (site, context) => originalFactory(site, { ...context, sleepFn: async ms => { pacingWaits.push(ms); }, randomFn: () => 0 });
  const cliPath = require.resolve('../src/cli');
  delete require.cache[cliPath];
  const cli = require(cliPath);
  factory.createSiteAdapter = originalFactory;
  reports.renderReports = originalRender;
  const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
  const bossPacing = { pacedActions: 2, nextPacingCooldownAt: 18, detailActions: 2, nextDetailMicroCooldownAt: 6, nextDetailMacroCooldownAt: 16 };
  storage.setSitePacingState(db, { site: 'boss', pacing: bossPacing });
  const bossBefore = storage.getSitePacingState(db, 'boss');
  storage.acquireSiteScanLease(db, { site: 'zhaopin', owner: 'prior-zl-pacing', planId: saved.planId, command: 'scan' });
  storage.beginScanRun(db, { runId: 'prior-zl-pacing', site: 'zhaopin', planId: saved.planId, leaseOwner: 'prior-zl-pacing', command: 'scan' });
  const priorBatchId = storage.createAndBindScanBatch(db, { runId: 'prior-zl-pacing', leaseOwner: 'prior-zl-pacing', site: 'zhaopin', keyword: 'AI', profileId: saved.profileId, searchPlanId: saved.planId });
  storage.checkpointScanProgress(db, { runId: 'prior-zl-pacing', batchId: priorBatchId, leaseOwner: 'prior-zl-pacing', jobs: [], runtime: { bossPacing: { pacedActions: 15, nextPacingCooldownAt: 18, detailActions: 15, nextDetailMicroCooldownAt: 18, nextDetailMacroCooldownAt: 16 } } });
  storage.finishScanRun(db, { runId: 'prior-zl-pacing', leaseOwner: 'prior-zl-pacing', status: 'completed' });
  storage.releaseSiteScanLease(db, { site: 'zhaopin', owner: 'prior-zl-pacing' });
  storage.acquireSiteScanLease(db, { site: 'zhaopin', owner: 'cli-zl', planId: saved.planId, command: 'scan' });
  storage.beginScanRun(db, { runId: 'cli-zl', site: 'zhaopin', planId: saved.planId, leaseOwner: 'cli-zl', command: 'scan' });
  const result = await cli.scan(db, { plan: plan.id, site: 'zhaopin', browser: 'edge', 'workflow-run': workflow.id, keywords: 'AI', 'max-cards': 3, 'max-detail-total': 3, 'browser-page-budget': 1 }, { execution: { runId: 'cli-zl', leaseOwner: 'cli-zl', logger }, createBrowser: () => fakeBrowser(), resolveScanModelSettingsContext: () => ({ root: dir }), resolveScanModelRuntime: () => ({ primaryState: runtime, backupState: null }) });
  assert.equal(result.status, 'completed');
  assert.equal(storage.getBatch(db, result.batchId).site, 'zhaopin');
  assert.notEqual(result.batchId, priorBatchId);
  assert.equal(storage.getBatch(db, result.batchId).filterSnapshot.runtime.bossPacing.detailActions, 18, 'a new Zhaopin batch must continue the prior round cumulative pacing, not restart at zero');
  assert.equal(storage.getSitePacingState(db, 'zhaopin').pacing.detailActions, 18);
  assert.equal(storage.getSitePacingState(db, 'zhaopin').pacing.nextDetailMacroCooldownAt, 32);
  assert(pacingWaits.includes(90000), 'the new batch must perform the inherited macro cooldown after detail 16');
  assert.deepEqual(storage.getSitePacingState(db, 'boss'), bossBefore, 'Zhaopin checkpoints must not change BOSS pacing or its timestamp');
  assert.equal(storage.listReportJobs(db, { batchId: result.batchId }).length, 3);
  const cliOutcomes = storage.listSiteAccessEvents(db, { site: 'zhaopin' }).filter(event => event.action === 'pane_detail_result' && event.details.runId === 'cli-zl');
  assert.equal(cliOutcomes.length, 3);
  assert(cliOutcomes.every(event => event.details.outcome === 'succeeded' && event.details.reused === true), 'persisted outcomes must distinguish verified cached reuse from new JD work');
  assert.equal(storage.getWorkflowRun(db, workflow.id).status, 'completed');
  storage.finishScanRun(db, { runId: 'cli-zl', leaseOwner: 'cli-zl', status: 'completed' });
  storage.releaseSiteScanLease(db, { site: 'zhaopin', owner: 'cli-zl' });
  savePlatformSearchContext(db, { planId: plan.id, site: 'zhaopin', searchTemplate: scope.searchTemplate, filterSummary: ['广东'] });
  let spawned;
  const server = require('../src/dashboard/server').createDashboardServer({ db, root: path.resolve(__dirname, '..'), dbPath: path.join(dir, 'fixture.sqlite'), dataRoot: dir, browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' }, forceMock: true, allowOfflineMock: true, logger: { ...logger, requestId: () => 'synthetic-http', listRecent: () => [] }, acquisitionContextResolver: input => resolveLiveAcquisitionContext({ ...input, browserFactory: () => fakeBrowser() }), spawnProcess: (_exe, args) => { spawned = args; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; } });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workflow-run`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ planId: String(plan.id), site: 'zhaopin', confirmEarlyScan: '1' }), redirect: 'manual' });
    assert.equal(response.status, 303, await response.text());
    const started = storage.listWorkflowRuns(db, { site: 'zhaopin', planId: plan.id }).find(item => item.sequence === 3);
    assert.equal(started.site, 'zhaopin');
    assert.equal(started.planner.site, 'zhaopin');
    assert.equal(started.planner.acquisitionMode, 'inherited');
    assert.equal(started.planner.searchScope.templateUrl, scope.searchScope.templateUrl);
    assert.equal(spawned[spawned.indexOf('--site') + 1], 'zhaopin');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
