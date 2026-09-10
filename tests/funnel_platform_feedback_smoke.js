const assert = require('node:assert/strict');
const storage = require('../src/core/storage');
const { createFunnelAnalysisService } = require('../src/application/funnel_analysis');

const db = storage.openDb(':memory:');
const now = '2026-09-10T08:00:00.000Z';
const service = createFunnelAnalysisService({ db, now: () => now });
let serial = 0;
try {
  const owner = createOwner();
  const initial = storage.ensureActiveFunnelStrategyRound(db, { ...owner, startedAt: '2026-09-01T00:00:00.000Z' });
  const bossCards = Array.from({ length: 20 }, () => seed(owner, initial.id, 'boss'));
  Array.from({ length: 20 }, () => seed(owner, initial.id, 'zhaopin'));
  event(bossCards[0], 'inbound_reply_observed', '2026-09-02T02:00:00.000Z');
  let result = service.getDashboard(owner);
  assert.equal(result.platforms?.length, 2, 'feedback must expose independently projected platform rows');
  assert.equal(row(result, 'boss').currentRound.started, 20);
  assert.equal(row(result, 'boss').currentRound.immediatePositive.replied, 1);
  assert.equal(row(result, 'zhaopin').currentRound.strength, 'facts');
  assert.equal(result.currentRound.strength, 'facts', 'two groups below 30 must not become a combined diagnosis');
  assert.equal(result.advice, null);

  const bossChange = service.startStrategyRound({ ...owner, fromRoundId: initial.id, sourceKey: 'boss-only',
    changeKinds: ['greeting'], platformScope: 'boss', startedAt: '2026-09-03T00:00:00.000Z' });
  const freshBoss = seed(owner, bossChange.id, 'boss', '2026-09-10T06:00:00.000Z');
  const freshZhaopin = seed(owner, bossChange.id, 'zhaopin', '2026-09-10T06:00:00.000Z');
  event(freshBoss, 'resume_requested', '2026-09-10T07:00:00.000Z');
  event(freshZhaopin, 'resume_requested', '2026-09-10T07:00:00.000Z');
  result = service.getDashboard(owner);
  assert.equal(result.activeRevisionId, bossChange.id);
  assert.equal(row(result, 'boss').currentRound.started, 1);
  assert.equal(row(result, 'boss').currentRound.mature, 0);
  assert.equal(row(result, 'boss').currentRound.immediatePositive.replied, 1, 'a fresh reply is visible before diagnostic maturity');
  assert.equal(row(result, 'boss').currentRound.immediatePositive.resumeRequested, 1);
  assert.equal(row(result, 'zhaopin').currentRound.started, 21, 'BOSS changes cannot reset Zhaopin');
  assert.equal(row(result, 'zhaopin').currentRound.id, initial.id);
  assert.equal(row(result, 'zhaopin').previousRound, null);
  assert.equal(row(result, 'boss').lifetime.started, 21);
  assert.equal(row(result, 'boss').lifetime.replied, 2);

  event(bossCards[1], 'resume_requested', '2026-09-10T07:10:00.000Z');
  result = service.getDashboard(owner);
  assert.equal(row(result, 'boss').currentRound.immediatePositive.resumeRequested, 1, 'late old feedback cannot move into the new strategy');
  assert.equal(row(result, 'boss').previousRound.immediatePositive.resumeRequested, 1);
  assert.equal(row(result, 'boss').lifetime.resumeRequested, 2);

  const otherPlan = createPlan(owner.profileId);
  const otherRound = storage.ensureActiveFunnelStrategyRound(db, { ...otherPlan, startedAt: '2026-09-01T00:00:00.000Z' });
  seed(otherPlan, otherRound.id, 'boss');
  const stranger = createOwner();
  const strangerRound = storage.ensureActiveFunnelStrategyRound(db, { ...stranger, startedAt: '2026-09-01T00:00:00.000Z' });
  seed(stranger, strangerRound.id, 'boss');
  result = service.getDashboard(owner);
  assert.equal(row(result, 'boss').lifetime.started, 22, 'lifetime includes other owned plans but not other profiles');
  assert.equal(row(result, 'boss').currentRound.started, 1);

  assert.throws(() => service.startStrategyRound({ ...owner, fromRoundId: bossChange.id,
    sourceKey: 'invalid', changeKinds: ['greeting'], platformScope: 'invalid' }), { code: 'FUNNEL_PLATFORM_INVALID' });
  assert.equal(service.getDashboard(owner).activeRevisionId, bossChange.id, 'invalid scope cannot close a strategy');

  const sharedInput = { ...owner, fromRoundId: bossChange.id, sourceKey: 'shared', changeKinds: ['resume'], startedAt: now };
  const shared = service.startStrategyRound(sharedInput);
  assert.equal(service.startStrategyRound(sharedInput).id, shared.id, 'repeat recording is idempotent');
  assert.throws(() => service.startStrategyRound({ ...sharedInput, platformScope: 'boss' }),
    { code: 'FUNNEL_ROUND_STALE' }, 'a changed platform is not an equivalent retry');
  result = service.getDashboard(owner);
  assert.equal(row(result, 'boss').currentRound.started, 0);
  assert.equal(row(result, 'zhaopin').currentRound.started, 0, 'shared changes start both platform strategies');
  assert.equal(row(result, 'zhaopin').previousRound.started, 21);
  assert.equal(row(result, 'boss').lifetime.started, 22);

  // More than the old 30/200 history cap must not silently drop an unchanged platform.
  let latest = shared;
  seed(owner, shared.id, 'zhaopin', now);
  for (let i = 0; i < 205; i++) latest = service.startStrategyRound({ ...owner, fromRoundId: latest.id,
    sourceKey: `boss-${i}`, platformScope: 'boss', changeKinds: ['greeting'], startedAt: now });
  result = service.getDashboard(owner);
  assert.equal(row(result, 'zhaopin').currentRound.started, 1);
  assert.equal(row(result, 'zhaopin').currentRound.id, shared.id);
  assert.equal(result.activeRevisionId, latest.id);

  // Legacy snapshots have no platform field and continue to affect both platforms.
  const legacy = JSON.parse(db.prepare('SELECT strategy_snapshot_json AS value FROM candidate_funnel_strategy_rounds WHERE id = ?').get(shared.id).value);
  delete legacy.platformScope;
  db.prepare('UPDATE candidate_funnel_strategy_rounds SET strategy_snapshot_json = ? WHERE id = ?').run(JSON.stringify(legacy), shared.id);
  assert.equal(row(service.getDashboard(owner), 'zhaopin').currentRound.id, shared.id);
  console.log('funnel_platform_feedback_smoke: ok');
} finally { db.close(); }

function row(value, site) { return value.platforms.find(item => item.site === site); }
function createOwner() {
  const stamp = '2026-09-01T00:00:00.000Z';
  const id = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES ('Synthetic', '{}', ?, ?)").run(stamp, stamp).lastInsertRowid);
  return createPlan(id);
}
function createPlan(profileId) {
  const stamp = '2026-09-01T00:00:00.000Z';
  const planId = Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at)
    VALUES (?, 'Synthetic plan', '{"directions":["AI"]}', 1, ?, ?)`).run(profileId, stamp, stamp).lastInsertRowid);
  return { profileId, planId };
}
function seed(owner, roundId, site, stamp = '2026-09-01T02:00:00.000Z') {
  const jobId = Number(db.prepare('INSERT INTO jobs(source, source_id, title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(site, `synthetic-${++serial}`, 'Synthetic job', stamp, stamp).lastInsertRowid);
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(profile_id, plan_id, job_id, source, recruiter_name, thread_key,
    stage, next_action, last_event_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', '', 'waiting_reply', '', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, jobId, site, stamp, stamp, stamp).lastInsertRowid);
  db.prepare(`INSERT INTO candidate_funnel_entries(profile_id, job_id, card_id, plan_id, strategy_round_id, source_kind,
    started_at, mature_at, direction_key, decision_bucket, greeting_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'communication', ?, ?, 'AI', 'apply', '', ?, ?)`)
    .run(owner.profileId, jobId, cardId, owner.planId, roundId, stamp, new Date(Date.parse(stamp) + 172800000).toISOString(), stamp, stamp);
  return cardId;
}
function event(cardId, type, stamp) {
  db.prepare(`INSERT INTO candidate_progress_events(card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, 'system', '', '{"source":"platform_observation"}', ?, ?)`)
    .run(cardId, `event-${++serial}`, type, stamp, stamp);
}
