const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { openDb } = require('../src/core/storage');
const { ensureProgressCard, recordDiscoveredMessageGroupClassification } = require('../src/core/candidate_progress');
const { ensureActiveFunnelStrategyRound } = require('../src/storage/funnel_store');
const { createFunnelAnalysisService } = require('../src/application/funnel_analysis');
const { buildFunnelSnapshot } = require('../src/core/funnel_maturity');
const { renderFunnelPage } = require('../src/dashboard/pages/funnel');
const { recordUnresolvedMessageDiscoveryItem } = require('../src/core/message_preview_state');

const db = openDb(':memory:');
const now = '2026-09-10T03:00:00.000Z';
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
try {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('Synthetic candidate','{}',?,?)").run(now, now).lastInsertRowid);
  const planId = addPlan(profileId);
  ensureActiveFunnelStrategyRound(db, { profileId, planId, startedAt: '2026-09-01T03:00:00.000Z' });
  for (const [index, source] of ['boss', 'zhaopin', 'zhaopin'].entries()) {
    addRequest({ profileId, planId, source, key: `main-${index}` });
  }
  addRequest({ profileId, planId: addPlan(profileId), source: 'zhaopin', key: 'another-plan' });
  const otherProfile = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('Another synthetic candidate','{}',?,?)").run(now, now).lastInsertRowid);
  addRequest({ profileId: otherProfile, planId: addPlan(otherProfile), source: 'zhaopin', key: 'another-profile' });
  const service = createFunnelAnalysisService({ db, now: () => now });
  for (const owner of [profileId, otherProfile]) {
    recordUnresolvedMessageDiscoveryItem(db, {
      profileId: owner, platform: 'zhaopin', conversationKey: digest(`unresolved-${owner}`),
      previewDigest: digest(`preview-${owner}`), previewKind: 'possible_hr_reply',
      reasonCode: 'ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED', observedAt: now,
      sourceJobId: 'zhaopin:ZLUNVERIFIED', lastMessageId: '123456',
      inboundMessages: [{ kind: 'resume_request', text: 'HR 邀请你发送简历' }]
    });
  }
  const dashboard = service.refresh({ profileId, planId });
  assert.equal(dashboard.untrackedFeedback?.resumeRequested, 3,
    'trusted resume requests must remain visible even without a known outbound start');
  assert.equal(dashboard.untrackedFeedback.replied, 3, 'duplicate classification is one opportunity');
  assert.equal(dashboard.lifetimeUntrackedFeedback?.resumeRequested, 4, 'cumulative extra messages include other owned plans only');
  assert.equal(dashboard.untrackedFeedback.pendingConversations, 1, 'pending conversations remain account-scoped without including another profile');
  assert.equal(dashboard.untrackedFeedback.pendingResumeRequests, 1, 'unverified identity must not hide a readable resume card');
  assert.equal(dashboard.currentRound.started, 0, 'HR-initiated messages are not fabricated applications');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_funnel_entries').get().n, 0);
  const page = renderFunnelPage({ plan: { id: planId }, dashboard });
  assert.match(page, /包含 HR 新招呼和对投递的回复，同一会话只计一次/);
  assert.match(page, /data-incoming-platform="boss"[\s\S]*?<td><a href="#incoming-boss-all-details">1<\/a><\/td>[\s\S]*?<td><a href="#incoming-boss-resume-details">1<\/a><\/td>/);
  assert.match(page, /data-incoming-platform="zhaopin"[\s\S]*?<td><a href="#incoming-zhaopin-all-details">4<\/a><\/td>[\s\S]*?<td><a href="#incoming-zhaopin-resume-details">4<\/a><\/td>/);
  assert.match(page, /incoming-zhaopin-resume-details[\s\S]*?href="\/messages\?planId=1&amp;source=zhaopin&amp;contact=sha256%3A[\da-f]+&amp;task=all"/,
    "the counted incoming contacts must expose a real matching conversation route");

  const entries = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, startedAt: '2026-09-01T03:00:00.000Z' }));
  const events = new Map(entries.map(entry => [entry.id, entry.id === 1
    ? [{ type: 'message_group_classified', occurredAt: '2026-09-02T03:00:00.000Z', metadata: { messageIntent: 'interest_check' } }]
    : [{ type: 'outbound_delivered_observed', occurredAt: '2026-09-02T03:00:00.000Z' }]]));
  const snapshot = buildFunnelSnapshot(entries, events, { now });
  assert.equal(snapshot.stages.replied.denominator, 1, 'conditional diagnosis stays conditional');
  const statsPage = renderFunnelPage({ plan: { id: planId }, dashboard: {
    platforms: [{ site: 'boss', currentRound: snapshot, lifetime: { started: 18, ...snapshot.immediatePositive } }]
  } });
  const replyRow = statsPage.match(/data-feedback-platform="boss"[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(replyRow, /5\.6%/, 'main reply share is 1 of 18 contacted jobs, never conditional 100%');
  assert.doesNotMatch(replyRow, /100\.0%/);
  assert.doesNotMatch(statsPage, /暂无明确状态|未知 0/);
  console.log('funnel_message_linkage_smoke ok');
} finally { db.close(); }

function addPlan(profileId) {
  return Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'Synthetic plan','{}',1,?,?)").run(profileId, now, now).lastInsertRowid);
}
function addRequest({ profileId, planId, source, key }) {
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,first_seen_at,last_seen_at) VALUES (?,?,'Synthetic role',?,?)").run(source, key, now, now).lastInsertRowid);
  const card = ensureProgressCard(db, { profileId, planId, jobId, source, now });
  const input = { cardId: card.id, platform: source, threadKey: digest(`${key}-thread`),
    messageKeys: [digest(`${key}-message`)], messageGroupKey: digest(`${key}-group`),
    messageIntent: 'interest_check', messageCategory: 'other', manualActions: [{ kind: 'resume_request' }],
    progressUpdate: { stage: 'needs_user_action' }, occurredAt: now };
  recordDiscoveredMessageGroupClassification(db, input);
  recordDiscoveredMessageGroupClassification(db, input);
}
