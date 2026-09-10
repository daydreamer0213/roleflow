const assert = require('node:assert/strict');
const { openDb, ensureActiveFunnelStrategyRound, startFunnelStrategyRound, saveMessageInboundContext } = require('../src/core/storage');
const { createFunnelAnalysisService } = require('../src/application/funnel_analysis');
const { createDashboardServer } = require('../src/dashboard/server');
const { renderFunnelPage } = require('../src/dashboard/pages/funnel');
const now = '2026-09-10T08:00:00.000Z';
const logger = { info() {}, warn() {}, error() {}, requestId() { return 'funnel-test'; }, listRecent() { return []; } };
let serial = 0;
(async () => {
  const db = openDb(':memory:');
  const owner = createOwner(db);
  const initial = ensureActiveFunnelStrategyRound(db, { ...owner, startedAt: '2026-09-01T00:00:00.000Z' });
  for (let i = 0; i < 3; i++) seed(db, owner, initial.id, 'boss');
  seed(db, owner, initial.id, 'zhaopin');
  const active = startFunnelStrategyRound(db, { ...owner, fromRoundId: initial.id, sourceKey: 'change',
    changeKinds: ['greeting'], platformScope: 'boss', startedAt: '2026-09-04T00:00:00.000Z' });
  for (let i = 0; i < 5; i++) seed(db, owner, active.id, 'boss', i < 2 ? 'resume_requested' : null, i === 0);
  seed(db, owner, active.id, 'zhaopin', 'resume_requested', true);
  seedIncomingContact(db, owner);
  const service = createFunnelAnalysisService({ db, now: () => now });
  const server = createDashboardServer({ db, forceMock: true, allowOfflineMock: true, logger,
    browserAuthority: { browserMode: 'edge', cdpPort: null, profilePath: '' }, funnelAnalysisService: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = values => fetch(base + '/api/funnel/strategy-round', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values), redirect: 'manual'
  });
  let browser;
  try {
    const pathname = `/funnel?planId=${owner.planId}`;
    const current = await (await fetch(base + pathname)).text();
    assert.match(current, /<table[^>]*aria-label="当前方案投递反馈"/, 'HTTP page identifies reporting scope');
    assert.match(current, /收到的联系/);
    assert.match(current, /包含 HR 新招呼和对投递的回复，同一会话只计一次/);
    assert.match(incomingPlatformRow(current, 'boss'), /1[\s\S]*1[\s\S]*0/);
    assert.match(incomingPlatformRow(current, 'boss'), /#incoming-boss-all-details[\s\S]*#incoming-boss-resume-details[\s\S]*#incoming-boss-interview-details/);
    assert.match(current, /<details id="incoming-boss-resume-details"/);
    assert.match(current, new RegExp(`/messages\\?planId=${owner.planId}&amp;source=boss&amp;contact=sha256%3A[a-f0-9]{64}&amp;task=all`));
    assert.doesNotMatch(current, /其他消息中还有/);
    assert.match(platformRow(current, 'boss'), /5[\s\S]*2[\s\S]*40%/, 'fresh replies use all 5 contacts');
    assert.match(platformRow(current, 'zhaopin'), /2[\s\S]*1[\s\S]*50%/);
    const lifetime = await (await fetch(base + pathname + '&view=lifetime')).text();
    assert.match(platformRow(lifetime, 'boss'), /8[\s\S]*2[\s\S]*25%/);
    assert.match(lifetime, /所有方案的本地记录/);
    assert.doesNotMatch(current, /成熟样本|当前策略轮次|环节转化明细|证据强度/);
    assert.match(current, /AI &lt;应用&gt;/);
    assert.doesNotMatch(current, /AI <应用>/);
    assert.equal((current.match(/<main(?:\s|>)/g) || []).length, 1);
    assert.match(current, /aria-current="page">求职体检<\/a>/);
    assert.match(current, new RegExp(`name="fromRoundId" value="${active.id}"`));
    assert.match(await (await fetch(base + '/funnel?planId=999999')).text(), /找不到这份筛选方案/);
    assert.equal((await post({ ...owner, fromRoundId: active.id, changeKinds: 'greeting', platformScope: 'bad' })).status, 400);
    assert.equal(service.getDashboard(owner).activeRevisionId, active.id);
    const zero = renderFunnelPage({ plan: { id: owner.planId }, dashboard: {
      platforms: [{ site: 'boss', currentRound: { started: 0, immediatePositive: {} }, lifetime: { started: 0 } }]
    } });
    assert.doesNotMatch(platformRow(zero, 'boss'), /0%/);
    assert.match(zero, /还没有联系岗位/);
    const advice = renderFunnelPage({ plan: { id: owner.planId }, dashboard: {
      ...service.getDashboard(owner), advice: { site: 'boss', stage: 'replied', title: '先检查招呼语和岗位匹配', numerator: 2, denominator: 20 }
    } });
    assert.match(advice, /20 个已读岗位中，2 个有回复/);
    assert.match(advice, /查看等待回复的岗位/);
    const advicePath = advice.match(/href="([^"]+)">查看等待回复的岗位/)?.[1].replace(/&amp;/g, '&');
    assert.match(advicePath || '', /pool=waiting_reply/);
    const adviceDestination = await (await fetch(base + advicePath)).text();
    assert.match(adviceDestination, /Synthetic/, 'advice opens existing contacted jobs, not an empty uncontacted queue');
    const comparable = service.getDashboard(owner);
    comparable.platforms[0].roundComparison = { status: 'ready', before: { replied: { numerator: 10, denominator: 50 } }, after: { replied: { numerator: 20, denominator: 50 } } };
    assert.match(renderFunnelPage({ plan: { id: owner.planId }, dashboard: comparable }), /20%[\s\S]*40%/);
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch (error) { if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === '1') throw error; }
    if (chromium) {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [], external = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await page.goto(base + pathname);
      assert.match(await page.locator('[data-feedback-platform="boss"]').innerText(), /40%/);
      assert.equal(await page.getByRole('button', { name: '保存调整记录', exact: true }).isVisible(), false);
      await page.getByRole('link', { name: '累计记录', exact: true }).click();
      assert.match(await page.locator('[data-feedback-platform="boss"]').innerText(), /25%/);
      await page.getByRole('link', { name: '当前方案', exact: true }).click();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`);
        for (const table of await page.locator('.feedback-table-scroll').all()) {
          assert.equal(await table.evaluate(el => el.scrollWidth <= el.clientWidth), true,
            `all feedback columns remain visible at ${width}`);
        }
      }
      await page.getByText('记录方案调整', { exact: true }).click();
      await page.getByLabel('调整的平台', { exact: true }).selectOption('boss');
      await page.getByRole('button', { name: '保存调整记录', exact: true }).click();
      assert.equal(service.getDashboard(owner).activeRevisionId, active.id, 'empty change cannot submit');
      await page.getByLabel('招呼语', { exact: true }).check();
      await Promise.all([page.waitForURL(base + pathname), page.getByRole('button', { name: '保存调整记录', exact: true }).click()]);
      const changed = service.getDashboard(owner);
      assert.notEqual(changed.activeRevisionId, active.id);
      assert.equal(changed.platforms.find(p => p.site === 'boss').currentRound.started, 0);
      assert.equal(changed.platforms.find(p => p.site === 'zhaopin').currentRound.started, 2);
      assert.equal((await post({ ...owner, fromRoundId: active.id, changeKinds: 'greeting', platformScope: 'boss' })).status, 303);
      assert.equal(service.getDashboard(owner).activeRevisionId, changed.activeRevisionId);
      assert.equal((await post({ ...owner, fromRoundId: initial.id, changeKinds: 'greeting', platformScope: 'boss' })).status, 409);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    }
    console.log('dashboard_funnel_smoke: ok');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve)); db.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
function platformRow(html, site) { return html.match(new RegExp(`<tr data-feedback-platform="${site}"[\\s\\S]*?</tr>`))?.[0] || ''; }
function incomingPlatformRow(html, site) { return html.match(new RegExp(`<tr data-incoming-platform="${site}"[\\s\\S]*?</tr>`))?.[0] || ''; }
function createOwner(db) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('Synthetic','{}',?,?)").run(now, now).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'AI <应用>','{}',1,?,?)").run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}
function seed(db, owner, roundId, site, type = null, fresh = false) {
  const stamp = fresh ? '2026-09-10T06:00:00.000Z' : '2026-09-01T02:00:00.000Z';
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,first_seen_at,last_seen_at) VALUES (?,?,'Synthetic',?,?)").run(site, `test-${++serial}`, stamp, stamp).lastInsertRowid);
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,recruiter_name,thread_key,stage,next_action,last_event_at,created_at,updated_at)
    VALUES (?,?,?,?,'','','waiting_reply','',?,?,?)`).run(owner.profileId, owner.planId, jobId, site, stamp, stamp, stamp).lastInsertRowid);
  db.prepare(`INSERT INTO candidate_funnel_entries(profile_id,job_id,card_id,plan_id,strategy_round_id,source_kind,started_at,mature_at,direction_key,decision_bucket,greeting_key,created_at,updated_at)
    VALUES (?,?,?,?,?,'communication',?,?,'AI','apply','',?,?)`).run(owner.profileId, jobId, cardId, owner.planId, roundId, stamp, new Date(Date.parse(stamp) + 172800000).toISOString(), stamp, stamp);
  if (type) db.prepare(`INSERT INTO candidate_progress_events(card_id,idempotency_key,type,actor,summary,metadata_json,occurred_at,created_at)
    VALUES (?,?,?,'system','','{}',?,?)`).run(cardId, `event-${serial}`, type, now, now);
}
function seedIncomingContact(db, owner) {
  const conversationKey = `sha256:${'a'.repeat(64)}`;
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,first_seen_at,last_seen_at) VALUES ('boss','incoming-1','Incoming','Incoming Co',?,?)").run(now, now).lastInsertRowid);
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,thread_key,stage,next_action,last_event_at,created_at,updated_at)
    VALUES (?, ?, ?, 'boss', ?, 'needs_user_action', '', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, jobId, conversationKey, now, now, now).lastInsertRowid);
  saveMessageInboundContext(db, {
    profileId: owner.profileId, cardId, platform: 'boss', conversationKey,
    messageGroupKey: `sha256:${'b'.repeat(64)}`, sourceJobId: 'boss:incoming_123456', lastMessageId: '123456789012345',
    messageIntent: 'information_request', messageCategory: 'other',
    inboundMessages: [{ kind: 'resume_request', text: 'HR 邀请你发送简历' }], manualActions: [{ kind: 'resume_request' }],
    createdAt: now, updatedAt: now
  });
}
