const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const storage = require('../src/core/storage');
const { matchingCardFromProfile } = require('../src/core/matching_card');
const { createDashboardServer, resolveLiveZhaopinContext } = require('../src/dashboard/server');
const { isCommunicationJobEligible } = require('../src/storage/communication_store');
const { renderReports } = require('../src/reports/render');
const { getPlatformSearchContext } = require('../src/storage/platform_search_context_store');
const root = path.resolve(__dirname, '..');
const logger = { info() {}, warn() {}, error() {}, child() { return this; }, requestId() { return 'synthetic-zhaopin'; }, listRecent() { return []; } };
const syntheticAnalyzer = {
  async understandJob({ job }) {
    return { jobId: job.sourceId, realRoleType: 'ai_application', roleSummary: 'Python AI 服务开发', responsibilityEvidence: ['JD：负责 Python AI 服务开发和接口设计'], coreRequirements: [{ label: 'Python', foundation: true, indispensable: true, evidence: 'JD：掌握 Python' }], hiddenRisks: [], jobQuality: { level: 'normal', concerns: [] }, evidenceSnippets: ['掌握 Python，具备项目开发经验'] };
  },
  async matchJob() {
    return { recommendation: 'apply', fitLevel: 'A', roleAlignment: 'aligned', roleResumeEvidence: ['简历：合成 Python 项目经历'], roleGaps: [], confidence: 0.88, fitReasons: ['Python 项目经历与岗位职责对应'], requirementMatches: [{ requirement: 'Python', state: 'matched', foundation: true, indispensable: true, jdEvidence: 'JD：掌握 Python', resumeEvidence: '简历：合成 Python 项目经历' }], jobQuality: { level: 'normal', concerns: [] }, missingPoints: [], riskQuestions: [], primaryProjects: [], evidence: { jd: ['负责 Python AI 服务开发和接口设计'], resume: ['合成 Python 项目经历'] } };
  }
};

function seed(db) {
  const profile = { candidate: { name: '合成候选人', city: '广州', targetTitles: ['AI工程师'] }, skills: [{ name: 'Python' }], projects: [] };
  const saved = storage.saveProfileAnalysis(db, { profile, document: { originalFileName: 'synthetic.txt', format: 'text', contentHash: 'synthetic-dashboard', text: '合成 Python 项目经历', diagnostics: {} }, searchPlan: { name: '合成筛选方案', acquisitionMode: 'generated', platform: { site: 'boss', generated: { cities: ['北京'], experience: ['3-5年（可冲）'], jobTypes: ['实习'] } }, allowExperienceStretch: false, directions: ['AI应用开发'], keywords: [{ word: 'AI工程师', priority: 'A' }, { word: 'Python', priority: 'A' }], salary: {}, bossActiveDays: 3 } });
  const draft = storage.createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId, resumeContentHash: 'synthetic-dashboard', card: matchingCardFromProfile(profile), source: 'migration' });
  storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
  return saved;
}

function fakeBrowser() {
  const tabs = [{ id: 'dashboard', windowId: 'window', active: true, url: 'http://127.0.0.1/plan' }];
  const browser = {
    tabs,
    prepareSearchClock: 0,
    prepareSearchNow: () => browser.prepareSearchClock,
    prepareSearchSleep: async ms => { browser.prepareSearchClock += ms; },
    async listTabs() { return tabs.map(tab => ({ ...tab })); },
    async createTab(openerId, url) { assert.equal(openerId, 'dashboard'); const tab = { id: 'zl-search', windowId: 'window', active: false, url }; tabs.push(tab); return tab; },
    async evalValue(id, expression) {
      assert.equal(id, 'zl-search');
      if (expression.includes('const clean =')) return true;
      return { url: tabs.find(tab => tab.id === id).url, filterSummary: ['广东'], cards: [], loading: false, risk: false, loginRequired: false, isSearchPage: true };
    },
    async bringToFront() { throw new Error('prepare must not recover by foregrounding a tab'); }
  };
  return browser;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-zhaopin-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = storage.openDb(dbPath);
  let server;
  try {
    const saved = seed(db);
    const bossBefore = storage.getSearchPlan(db, saved.planId).plan;
    const ids = [];
    for (const [source, title] of [['boss', '旧BOSS岗位'], ['zhaopin', '智联完整岗位'], ['boss', '新BOSS岗位']]) {
      const batchId = storage.createBatch(db, source, 'AI', 'synthetic', { profileId: saved.profileId, searchPlanId: saved.planId, filterSnapshot: { execution: { site: source } } });
      storage.upsertJob(db, { source, sourceId: String(batchId), title, company: '招聘发布方', clientCompany: source === 'zhaopin' ? '实际用人公司' : '', url: source === 'boss' ? `https://www.zhipin.com/job_detail/synthetic${batchId}.html` : `https://www.zhaopin.com/jobdetail/SYNTH${batchId}.htm`, description: '完整职责和任职要求。'.repeat(40), score: 90, level: '优先', decisionBucket: 'primary', analysis: { semanticStatus: 'complete', recommendation: 'apply', companyOpportunity: '实际用人公司负责产品研发', roleSummary: '设计和实现 AI 服务', fitReasons: ['Python 经验匹配'] } }, batchId);
      ids.push({ batchId, job: storage.listReportJobs(db, { batchId })[0] });
    }
    assert.equal(storage.getLatestBatchId(db, { planId: saved.planId, site: 'zhaopin' }), ids[1].batchId, 'latest batch must belong to selected platform');
    assert.equal(storage.getLatestMainScanBatchId(db, { planId: saved.planId, site: 'zhaopin' }), ids[1].batchId);
    assert.equal(isCommunicationJobEligible(db, { ...ids[1].job, url: ids[2].job.url, decisionBucket: 'primary', qualityTags: [], applicationStatus: '' }), false, 'a BOSS URL must not authorize a ZL source');
    const bridge = fakeBrowser();
    server = createDashboardServer({ db, root, dbPath, browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(dir, 'synthetic-edge') }, forceMock: true, allowOfflineMock: true, logger, browserFactory: () => bridge, browserReadinessProbe: async () => ({ ready: true, status: 'ready', message: '合成浏览器已就绪', checkedAt: new Date().toISOString() }), planRescore: () => ({ rescored: 0 }), acquisitionContextResolver: input => resolveLiveZhaopinContext({ ...input, browserFactory: () => bridge }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
    const page = await (await fetch(`${base}/plan?planId=${saved.planId}&site=zhaopin`)).text();
    assert.match(page, /name="site"/);
    assert.match(page, /保存智联条件/);
    let response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(new URL(bridge.tabs[1].url).searchParams.get('kw'), 'AI工程师');
    assert.equal(new URL(bridge.tabs[1].url).searchParams.has('jl'), false, 'first open must not force a region');
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200);
    assert.equal(bridge.tabs.length, 2, 'reuse existing search tab');
    bridge.tabs[1].windowId = 'another-window';
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 409, 'do not reuse another window identity');
    response = await post('/api/platform-search/save', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 409, 'save must verify workspace window before persisting conditions');
    assert.equal(getPlatformSearchContext(db, { planId: saved.planId, site: 'zhaopin' }), null);
    bridge.tabs[1].windowId = 'window';
    bridge.tabs[1].url = 'https://www.zhaopin.com/jobs/?pageMode=search&jl=548';
    bridge.navigate = async (id, url) => { assert.equal(id, 'zl-search'); bridge.tabs[1].url = url; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200);
    assert.equal(new URL(bridge.tabs[1].url).searchParams.get('kw'), 'AI工程师', 'existing empty search needs first keyword');
    assert.equal(new URL(bridge.tabs[1].url).searchParams.get('jl'), '548');
    response = await post('/api/platform-search/save', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(getPlatformSearchContext(db, { planId: saved.planId, site: 'zhaopin' }).filterSummary[0], '广东');
    assert.deepEqual(storage.getSearchPlan(db, saved.planId).plan, bossBefore);
    bridge.tabs[1].windowId = 'another-window';
    response = await post('/api/workflow-run', { planId: saved.planId, site: 'zhaopin', confirmEarlyScan: '1' });
    assert.equal(response.status, 400, 'start must reject a search outside the workspace window');
    assert.match(await response.text(), /ZHAOPIN_WINDOW_MISMATCH/);
    assert.equal(storage.listWorkflowRuns(db, { site: 'zhaopin', planId: saved.planId }).length, 0);
    bridge.tabs[1].windowId = 'window';
    bridge.tabs[1].url += '&unknown=keep';
    response = await post('/api/platform-search/save', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 409, 'unknown native conditions must fail before storage');
    bridge.tabs[1].url = bridge.tabs[1].url.replace('&unknown=keep', '');
    for (const route of ['/jobs', '/settings', '/onboarding']) {
      bridge.tabs[0].url = base + route;
      response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
      assert.equal(response.status, 200, `same-window ${route} must remain a workspace owner: ` + await response.text());
      response = await post('/api/platform-search/save', { planId: saved.planId, site: 'zhaopin' });
      assert.equal(response.status, 200, await response.text());
    }
    bridge.tabs[0].url = base + '/plan';
    assert.deepEqual(storage.getSearchPlan(db, saved.planId).plan, bossBefore);
    const jobs = await (await fetch(`${base}/jobs?planId=${saved.planId}&site=zhaopin&status=all`)).text();
    assert.match(jobs, /智联完整岗位/);
    assert.doesNotMatch(jobs, /新BOSS岗位/);
    assert.match(jobs, /用人公司.*实际用人公司/);
    assert.doesNotMatch(jobs, /生成定制招呼语|生成 HR 回复|<button[^>]*value="applied"/);
    const queue = await (await fetch(`${base}/queue?planId=${saved.planId}&site=zhaopin&scope=new`)).text();
    assert.match(queue, /智联完整岗位/); assert.doesNotMatch(queue, /新BOSS岗位|批量沟通清单|活跃待核验/);
    const mixed = await (await fetch(`${base}/jobs?planId=${saved.planId}&site=all&batch=all&status=all`)).text();
    assert.match(mixed, /智联完整岗位/); assert.match(mixed, /新BOSS岗位/);
    assert.match(mixed, /来源：BOSS/);
    const mixedDefault = await (await fetch(`${base}/jobs?planId=${saved.planId}&site=all&status=all`)).text();
    assert.match(mixedDefault, /智联完整岗位/); assert.match(mixedDefault, /新BOSS岗位/);
    const exported = await (await fetch(`${base}/jobs/export.csv?profileId=${saved.profileId}&planId=${saved.planId}&site=zhaopin&status=all`)).text();
    assert.match(exported, /智联完整岗位/); assert.doesNotMatch(exported, /新BOSS岗位/);
    const exportRows = csvFixtureRows(exported);
    assert.equal(exportRows.length, 1);
    assert.deepEqual(['来源', '用人公司', '发布方'].map(key => exportRows[0][key]), ['智联', '实际用人公司', '招聘发布方']);
    const mixedCsv = await (await fetch(`${base}/jobs/export.csv?profileId=${saved.profileId}&planId=${saved.planId}&site=all&status=all`)).text();
    const mixedRows = csvFixtureRows(mixedCsv);
    assert.equal(mixedRows.length, 3);
    assert.deepEqual(mixedRows.filter(row => row['来源'] === '智联').map(row => row['用人公司']), ['实际用人公司']);
    assert.equal(mixedRows.filter(row => row['来源'] === 'BOSS').length, 2);
    assert(mixedRows.every(row => row['公司'] === '招聘发布方'), 'legacy company column preserved');
    response = await post('/api/mark', { profileId: saved.profileId, planId: saved.planId, jobId: ids[1].job.id, status: 'applied' });
    assert.equal(response.status, 400, await response.text());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_funnel_entries').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_job_states WHERE job_id=?').get(ids[1].job.id).n, 0, 'failed readonly sample must roll back manual state');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_job_events WHERE job_id=?').get(ids[1].job.id).n, 0);
    assert.equal((await fetch(`${base}/api/runtime-status?site=zhaopin`)).status, 200, 'rejected mark must leave HTTP service usable');
    const progress = require('../src/core/candidate_progress');
    const card = progress.ensureProgressCard(db, { profileId: saved.profileId, planId: saved.planId, jobId: ids[1].job.id, source: 'synthetic', now: new Date().toISOString() });
    response = await post('/api/progress', { cardId: card.id, action: 'reply_confirmed_sent', idempotencyKey: 'synthetic-readonly-rejection' });
    assert.notEqual(response.status, 303, await response.text());
    assert.equal(progress.getProgressCardById(db, card.id).stage, 'contact_started');
    assert.equal(progress.listProgressEvents(db, card.id).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_funnel_entries').get().n, 0);
    response = await post('/api/communication-batch', { profileId: saved.profileId, planId: saved.planId, jobIds: [ids[1].job.id] });
    assert.notEqual(response.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM communication_batches').get().n, 0);
    const mixedReport = renderReports([ids[0].job, ids[1].job], dir);
    assert.match(path.basename(mixedReport.htmlPath), /^mixed_/);
    assert.match(fs.readFileSync(mixedReport.htmlPath, 'utf8'), /来源：智联/);
    assert.match(fs.readFileSync(mixedReport.htmlPath, 'utf8'), /来源：BOSS/);
    const emptyReport = renderReports([], dir, { site: 'zhaopin' });
    assert.match(path.basename(emptyReport.htmlPath), /^zhaopin_/);
    assert.match(fs.readFileSync(emptyReport.htmlPath, 'utf8'), /智联岗位筛选报告/);
    const report = renderReports([{ ...ids[1].job, description: '完整描述'.repeat(100) + '完整JD结尾', analysis: { ...ids[1].job.analysis, greetingAngle: '不得出现的沟通角度' } }], dir);
    assert.doesNotMatch(fs.readFileSync(report.htmlPath, 'utf8'), /复制招呼语|沟通角度/);
    assert.match(fs.readFileSync(report.htmlPath, 'utf8'), /完整JD结尾/);
    assert.match(fs.readFileSync(report.mdPath, 'utf8'), /用人公司.*发布方/);
    assert.throws(() => renderReports([], path.join(dir, 'invalid-report'), { site: '../escape' }), /source|来源/i);
    assert.equal(fs.existsSync(path.join(dir, 'invalid-report')), false, 'invalid source rejected before output writes');
    let navigationCalls = 0;
    let pendingUrl = '';
    let postNavigationReads = 0;
    bridge.tabs.splice(0, bridge.tabs.length,
      { id: 12, windowId: 4, active: true, url: `${base}/plan` },
      { id: 20, windowId: 4, active: false, url: 'https://www.zhaopin.com/jobs/?pageMode=recommend' }
    );
    bridge.listTabs = async () => {
      if (pendingUrl && postNavigationReads++ >= 2) bridge.tabs[1].url = pendingUrl;
      return bridge.tabs.map(tab => ({ ...tab }));
    };
    bridge.navigate = async (id, url) => { assert.equal(id, 20); navigationCalls += 1; pendingUrl = url; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(navigationCalls, 1, 'navigation settling must not issue a second navigate');
    assert.equal(new URL(bridge.tabs[1].url).searchParams.get('kw'), 'AI工程师');

    let createCalls = 0;
    let createListReads = 0;
    const delayedCreated = { id: 27, windowId: 4, active: false, url: '' };
    bridge.tabs.splice(0, bridge.tabs.length, { id: 12, windowId: 4, active: true, url: `${base}/plan` });
    bridge.listTabs = async () => {
      if (createCalls && createListReads++ >= 2 && !bridge.tabs.includes(delayedCreated)) bridge.tabs.push(delayedCreated);
      return bridge.tabs.map(tab => ({ ...tab }));
    };
    bridge.createTab = async (openerId, url) => { assert.equal(openerId, 12); createCalls += 1; delayedCreated.url = url; return '27'; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(createCalls, 1, 'delayed tab discovery must not create a duplicate');
    assert.equal(bridge.tabs[1].id, 27, 'fresh Edge list ID remains numeric even when create returns a string');

    for (const unsafe of [
      { id: 28, windowId: 9, active: false, label: 'wrong-window' },
      { id: 28, windowId: 4, active: true, label: 'active-tab' }
    ]) {
      let closeCalls = 0;
      bridge.tabs.splice(0, bridge.tabs.length, { id: 12, windowId: 4, active: true, url: `${base}/plan` });
      bridge.listTabs = async () => bridge.tabs.map(tab => ({ ...tab }));
      bridge.createTab = async (_openerId, url) => { createCalls += 1; bridge.tabs.push({ ...unsafe, url }); return '28'; };
      bridge.closeTab = async id => { closeCalls += 1; assert.equal(id, 28); bridge.tabs.splice(bridge.tabs.findIndex(tab => tab.id === id), 1); };
      response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
      assert.equal(response.status, 409, `${unsafe.label} created tab must be rejected`);
      assert.equal(closeCalls, 1, 'only the attributable new tab is cleaned');
      assert.deepEqual(bridge.tabs.map(tab => tab.id), [12]);
    }

    let existingCloseCalls = 0;
    bridge.tabs.splice(0, bridge.tabs.length,
      { id: 12, windowId: 4, active: true, url: `${base}/plan` },
      { id: 20, windowId: 4, active: false, url: 'https://www.zhaopin.com/jobs/?pageMode=recommend' }
    );
    bridge.listTabs = async () => bridge.tabs.map(tab => ({ ...tab }));
    bridge.navigate = async (_id, url) => { navigationCalls += 1; const wrong = new URL(url); wrong.searchParams.set('kw', '另一个关键词'); bridge.tabs[1].url = wrong.toString(); };
    bridge.closeTab = async () => { existingCloseCalls += 1; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 409, 'a committed same-host URL with the wrong keyword must fail');
    assert.equal(existingCloseCalls, 0, 'an existing user search tab must never be closed');

    bridge.prepareSearchClock = 0;
    bridge.tabs[1].url = 'https://www.zhaopin.com/jobs/?pageMode=recommend';
    bridge.navigate = async () => { navigationCalls += 1; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    const timeoutBody = await response.text();
    assert.equal(response.status, 409, timeoutBody);
    assert.match(timeoutBody, /ZHAOPIN_SEARCH_NAVIGATION_TIMEOUT/, 'unchanged old URL gets the specific bounded timeout');
    assert.equal(existingCloseCalls, 0, 'navigation timeout must not close an existing tab');

    let closeVisibilityReads = 0;
    let closingId = null;
    bridge.prepareSearchClock = 0;
    bridge.tabs.splice(0, bridge.tabs.length, { id: 12, windowId: 4, active: true, url: `${base}/plan` });
    bridge.listTabs = async () => {
      if (closingId !== null && closeVisibilityReads++ >= 2) {
        bridge.tabs.splice(bridge.tabs.findIndex(tab => tab.id === closingId), 1);
        closingId = null;
      }
      return bridge.tabs.map(tab => ({ ...tab }));
    };
    bridge.createTab = async (_openerId, url) => {
      bridge.tabs.push({ id: 29, windowId: 4, active: false, url });
      throw Object.assign(new Error('synthetic create failure'), { code: 'BROWSER_COMMAND_FAILED' });
    };
    bridge.closeTab = async id => { assert.equal(id, 29); closingId = id; };
    response = await post('/api/platform-search/open', { planId: saved.planId, site: 'zhaopin' });
    assert.equal(response.status, 409, await response.text());
    assert.deepEqual(bridge.tabs.map(tab => tab.id), [12], 'failed create cleanup waits until the attributable tab is gone');
    console.log('dashboard_zhaopin_smoke HTTP/storage/report ok');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function journey() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error;
    console.log('dashboard_zhaopin_smoke browser journey skipped: provide existing Playwright using NODE_PATH'); return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaopin-ui-'));
  const evidence = process.env.ROLEFLOW_UI_EVIDENCE || path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const dbPath = path.join(dir, 'fixture.sqlite');
  let db = storage.openDb(dbPath), server, browser;
  let releaseAnalysis = () => {};
  let pausedOnce = false, analysisCalls = 0;
  const calls = [], failures = [], externalRequests = [];
  const pendingChildren = new Set();
  const bridge = fakeBrowser();
  let selected = 0;
  const baseRead = bridge.evalValue;
  bridge.navigate = async (id, url) => { assert.equal(id, 'zl-search'); bridge.tabs[1].url = url; selected = 0; };
  bridge.evalValue = async (id, expression) => {
    const base = await baseRead(id, expression);
    if (base === true) return true;
    if (expression.includes('__zhaopinActivateCard(')) { selected = Number(expression.match(/ActivateCard\((\d+)/)[1]); return { ready: true }; }
    if (expression.includes('__zhaopinScrollResults')) return true;
    const cards = [0, 1, 2].map(index => ({ index, signature: `synthetic-${index}`, title: `AI工程师 合成岗位${index}`, company: '合成招聘发布方', salary: '10-20K', location: '广州', experience: '经验不限', education: '本科' }));
    return { ...base, cards, selectedIndex: selected, keyword: new URL(base.url).searchParams.get('kw'), confirmedEnd: true, detail: { ...cards[selected], clientCompany: '合成产品研发公司', description: '岗位职责：负责 Python AI 服务开发和接口设计，维护应用系统。任职要求：掌握 Python，具备项目开发经验。团队重视文档与测试。'.repeat(8), url: `https://www.zhaopin.com/jobdetail/UI${selected}.htm` } };
  };
  const siteFactory = require('../src/adapters/sites');
  const originalSiteFactory = siteFactory.createSiteAdapter;
  const phases = require('../src/core/job_analysis');
  const originalPhase = phases.runWorkflowAnalysisPhase;
  const reports = require('../src/reports/render');
  const originalReport = reports.renderReports;
  // Existing dependency seams: real CLI, adapter and analysis executor with synthetic transport/model only.
  siteFactory.createSiteAdapter = (site, context) => originalSiteFactory(site, { ...context, sleepFn: async () => {}, randomFn: () => 0 });
  phases.runWorkflowAnalysisPhase = (database, input) => originalPhase(database, { ...input, createAnalyzeJob: (runtime, options) => {
    assert.deepEqual(input.configs.profile.location.target_cities, ['广州'], 'normal and analysis-only CLI must derive inherited runtime before adding BOSS generated constraints');
    assert.deepEqual(input.configs.targetPolicy.jobTypes, ['全职']);
    assert.deepEqual(input.configs.scoring.experience.selected, []);
    const analyze = phases.createJobAnalysisRunner({ ...input.configs, model: runtime.modelConfig || input.configs.model }, input.keywordPlan, { db: database, logger: options.logger, errorMode: 'throw', analyzer: syntheticAnalyzer });
    return async (job, opts) => {
      analysisCalls++;
      if (!pausedOnce && analysisCalls === 2) {
        pausedOnce = true;
        await new Promise(resolve => { releaseAnalysis = resolve; });
      }
      return analyze(job, opts);
    };
  } });
  reports.renderReports = (jobs, _out, context) => originalReport(jobs, path.join(dir, 'reports'), context);
  delete require.cache[require.resolve('../src/cli')];
  const cli = require('../src/cli');
  siteFactory.createSiteAdapter = originalSiteFactory;
  phases.runWorkflowAnalysisPhase = originalPhase;
  reports.renderReports = originalReport;
  try {
    const saved = seed(db);
    const bossBefore = storage.getSearchPlan(db, saved.planId).plan;
    const settings = require('../src/core/model_settings');
    const mockConfig = { provider: 'mock', concurrency: 1, providers: { mock: { model: 'offline-structured-mock' } } };
    await settings.saveVerifiedModelTaskProfile({ root: dir, taskProfile: 'batch_screening', fallbackModelConfig: mockConfig, input: { preset: 'mock', model: 'offline-structured-mock', concurrency: 1 } });
    const runtime = settings.resolveRuntimeModelConfig({ root: dir, taskProfile: 'batch_screening', fallbackModelConfig: mockConfig });
    runtime.concurrency = 1;
    const spawnProcess = (_exe, command) => {
      calls.push(command);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      const args = {};
      for (let i = 0; i < command.length; i++) if (command[i].startsWith('--')) args[command[i].slice(2)] = command[i + 1]?.startsWith('--') || !command[i + 1] ? true : command[++i];
      const work = new Promise(resolve => setImmediate(resolve)).then(async () => {
        const runId = args['run-id'], owner = `fixture:${runId}`;
        const analysisOnly = args['analysis-only'] === true;
        if (!analysisOnly) storage.acquireSiteScanLease(db, { site: args.site, owner, planId: Number(args.plan), command: 'scan' });
        storage.beginScanRun(db, { runId, site: args.site, planId: Number(args.plan), leaseOwner: analysisOnly ? undefined : owner, command: 'scan' });
        const execution = { runId, leaseOwner: analysisOnly ? null : owner, workflowRunId: args['workflow-run'], site: args.site, logger };
        try {
          await cli.executeTrackedScanRun(db, { runId, leaseOwner: execution.leaseOwner, runLogger: logger, execution, run: () => cli.scan(db, args, { execution, createBrowser: () => bridge, resolveScanModelSettingsContext: () => ({ root: dir }), resolveScanModelRuntime: () => ({ primaryState: runtime, backupState: null }) }) });
          child.emit('close', 0);
        } catch (error) { failures.push(`${error.code}: ${error.message}`); child.emit('close', 1); }
        finally { if (!analysisOnly) storage.releaseSiteScanLease(db, { site: args.site, owner }); }
      });
      pendingChildren.add(work); work.finally(() => pendingChildren.delete(work));
      return child;
    };
    const startServer = async () => {
      server = createDashboardServer({ db, root, dataRoot: dir, dbPath, browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(dir, 'edge') }, forceMock: true, allowOfflineMock: true, logger, browserFactory: () => bridge, browserReadinessProbe: async () => ({ ready: true, status: 'ready', message: '合成浏览器已就绪', checkedAt: new Date().toISOString() }), workflowResumeBrowserReadinessProbe: async () => ({ ready: true, status: 'ready', message: '合成浏览器已就绪', checkedAt: new Date().toISOString() }), acquisitionContextResolver: input => resolveLiveZhaopinContext({ ...input, browserFactory: () => bridge }), spawnProcess, planRescore: () => ({ rescored: 0 }) });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    };
    let base = await startServer();
    const readiness = await fetch(base + '/api/browser-readiness');
    assert.equal(readiness.status, 200, await readiness.text());
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') { externalRequests.push(url.origin); return route.abort(); }
      return route.continue();
    });
    const audit = async label => {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: no horizontal overflow ${viewport.width} ` + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(node => [node.tagName, node.className, node.getBoundingClientRect().right]))));
        assert.doesNotMatch(await page.locator('[data-runtime-status]').innerText(), /登录 BOSS|检查 BOSS/);
        await page.screenshot({ path: path.join(evidence, `${label}-${viewport.width}.png`), fullPage: true });
      }
    };
    await page.goto(`${base}/plan?planId=${saved.planId}`);
    assert.equal(await page.getByLabel('本次找岗平台').inputValue(), 'boss');
    await page.getByLabel('本次找岗平台').selectOption('zhaopin');
    await page.waitForURL(/site=zhaopin/);
    assert.equal(await page.locator('h1').innerText(), '发现并分析值得关注的岗位。');
    assert.equal(await page.locator('[data-today-primary]').innerText(), '准备智联搜索页');
    await audit('first-use');
    await page.getByRole('button', { name: '准备智联搜索页', exact: true }).click();
    await page.getByText('智联搜索页已在同窗后台准备。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '保存智联条件', exact: true }).click();
    await page.waitForURL(/platformSaved=1/);
    await page.reload();
    assert.equal(await page.getByLabel('本次找岗平台').inputValue(), 'zhaopin');
    assert.deepEqual(storage.getSearchPlan(db, saved.planId).plan, bossBefore);
    db.prepare('UPDATE search_plans SET profile_version_id = NULL WHERE id = ?').run(saved.planId);
    await page.reload();
    await page.getByRole('link', { name: '重新确认筛选条件', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('site'), 'zhaopin', 'stale-plan CTA preserves source');
    assert.equal(await page.getByLabel('本次找岗平台').inputValue(), 'zhaopin');
    if (!await page.locator('#plan-settings').evaluate(node => node.open)) await page.locator('#plan-settings > summary').click();
    assert.equal(await page.locator('input[name="bossActiveDays"]').count(), 0);
    assert.equal(await page.locator('input[name="acquisitionMode"]').count(), 0);
    assert.equal(await page.locator('input[name="salaryMinK"]').inputValue(), '');
    assert.equal(await page.locator('input[name="allowPartTime"]').isChecked(), false);
    await page.getByRole('button', { name: '保存筛选方案', exact: true }).click();
    await page.waitForURL(/saved=1/);
    const planAfter = storage.getSearchPlan(db, saved.planId).plan;
    for (const key of ['acquisitionMode', 'platform', 'bossActiveDays']) assert.deepEqual(planAfter[key], bossBefore[key], `ZL local save preserves BOSS ${key}`);
    await audit('saved');
    await page.getByRole('button', { name: '开始一轮岗位发现', exact: true }).click();
    await page.waitForURL(/workflow\?runId=/);
    const runId = new URL(page.url()).searchParams.get('runId');
    await waitFor(() => analysisCalls >= 2 || failures.length, 'real CLI reaches second synthetic analysis');
    assert.deepEqual(failures, []);
    const beforePause = storage.listReportJobs(db, { batchId: storage.getWorkflowRun(db, runId).scanBatchId });
    assert(beforePause.some(job => job.analysis.semanticStatus === 'complete'), 'one real analysis must be saved before pause: ' + JSON.stringify(db.prepare('SELECT * FROM workflow_job_tasks').all()) + JSON.stringify(beforePause.map(job => ({ id: job.id, analysis: job.analysis.semanticStatus, source: job.analysis.decisionSource }))));
    await page.goto(`${base}/plan?planId=${saved.planId}&site=boss`);
    assert.equal(storage.getWorkflowRun(db, runId).site, 'zhaopin', 'running source remains frozen after page selection changes');
    await page.goto(`${base}/workflow?runId=${runId}`);
    assert.equal(await page.locator('[data-runtime-status]').getAttribute('data-site'), 'zhaopin');
    await page.getByRole('button', { name: '暂停本轮', exact: true }).click();
    await waitFor(() => storage.getWorkflowRun(db, runId).controlState === 'pause_requested', 'HTTP pause request');
    releaseAnalysis();
    await waitFor(() => storage.getWorkflowRun(db, runId).status === 'paused', 'real executor pauses');
    await Promise.all([...pendingChildren]);
    await page.reload(); await audit('paused');
    await page.goto(`${base}/plan?planId=${saved.planId}&site=boss`);
    assert.equal(storage.getWorkflowRun(db, runId).site, 'zhaopin', 'page selector cannot change frozen workflow source');
    await new Promise(resolve => server.close(resolve)); server = null; db.close();
    db = storage.openDb(dbPath);
    base = await startServer();
    bridge.tabs[1].windowId = 'another-window';
    await page.goto(`${base}/workflow?runId=${runId}`);
    await page.getByRole('button', { name: '继续本轮', exact: true }).click();
    await waitFor(() => storage.getWorkflowRun(db, runId).status === 'completed' || failures.length, 'resumed real CLI completes');
    await Promise.all([...pendingChildren]);
    assert.deepEqual(failures, []);
    assert.equal(storage.getWorkflowRun(db, runId).site, 'zhaopin');
    bridge.tabs[1].windowId = 'window';
    const result = storage.listReportJobs(db, { batchId: storage.getWorkflowRun(db, runId).scanBatchId });
    assert.equal(result.length, 3); assert(result.every(job => job.analysis.semanticStatus === 'complete'));
    await page.reload(); await audit('completed');
    assert.equal(await page.locator('[data-overview-recommendations]').count(), 0);
    assert.equal(await page.locator('[data-overview-next-action]').count(), 0, 'completed ZL has no duplicate next step');
    assert.doesNotMatch(await page.locator('.workflow-primary').innerText(), /等待下一次状态更新|可用推荐/);
    await page.getByRole('link', { name: '查看智联结果', exact: true }).click();
    assert.equal(await page.locator('article.job').count(), 3);
    assert.equal(await page.locator('h1').innerText(), '智联岗位分析结果');
    assert.doesNotMatch(await page.locator('article.job').first().innerText(), /请结合完整 JD 确认岗位要求/);
    assert(await page.locator('[data-job-export]').first().evaluate(node => node.getBoundingClientRect().width < 30 && node.getBoundingClientRect().height < 30), 'compact export checkbox');
    assert.equal(await page.getByRole('button', { name: /发送|已投|招呼语/ }).count(), 0);
    await audit('results');
    await page.getByLabel('结果来源').selectOption('all');
    await page.getByRole('button', { name: '过滤', exact: true }).click();
    await page.waitForURL(/site=all/);
    assert.equal(await page.locator('[data-runtime-status]').getAttribute('data-site'), 'zhaopin', 'mixed display retains current work source');
    await page.getByLabel('结果来源').selectOption('zhaopin');
    await page.getByLabel('搜索岗位').fill('合成岗位');
    await page.getByRole('button', { name: '过滤', exact: true }).click();
    await page.waitForURL(/site=zhaopin/);
    assert.equal(await page.locator('article.job').count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'narrow sanity');
    assert.deepEqual(externalRequests, []);
    assert(calls.every(command => command[command.indexOf('--site') + 1] === 'zhaopin'));
    assert(calls.some(command => !command.includes('--analysis-only')));
    assert(calls.some(command => command.includes('--analysis-only')), 'restart must exercise actual analysis-only CLI');
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ scope: 'real HTTP dashboard + temporary SQLite + real cli.scan and analysis executor; synthetic browser transport and offline mock only', runId, calls, resultCount: result.length, analysisCalls, failures, externalRequests, screenshots: fs.readdirSync(evidence).filter(name => name.endsWith('.png')), limitations: ['No real platform browser transport or account', 'No real model quality acceptance', 'Child spawn is an in-process test seam; service and database are reopened'] }, null, 2));
    console.log(`dashboard_zhaopin_smoke actual browser journey ok: ${evidence}`);
  } finally {
    releaseAnalysis();
    await Promise.allSettled([...pendingChildren]);
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// These fixture rows deliberately contain no embedded newlines.
function csvFixtureRows(csv) {
  const rows = csv.replace(/^\ufeff/, '').trimEnd().split('\r\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replace(/""/g, '"')));
  return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, index) => [key, row[index]])));
}
async function waitFor(predicate, label) {
  const end = Date.now() + 20000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
main().then(journey).catch(error => { console.error(error.stack); process.exitCode = 1; });
