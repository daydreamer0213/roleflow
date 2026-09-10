const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = require('../src/core/storage');
const { recordUnresolvedMessageDiscoveryItem } = require('../src/core/message_preview_state');
const { listIncomingContacts } = require('../src/application/funnel_analysis');

const NOW = '2026-09-10T08:00:00.000Z';
const db = storage.openDb(':memory:');
let serial = 0;

try {
  const owner = createOwner('Primary');
  const other = createOwner('Other');
  const linkedConversation = digest('linked-conversation');
  const unresolvedConversation = digest('unresolved-conversation');
  const blankConversation = digest('blank-conversation');
  const bossCard = createCard(owner, 'boss', linkedConversation, 'BOSS role', 'BOSS Co');
  saveContext(owner, bossCard, 'boss', linkedConversation, 'first-group', [{ kind: 'text', text: '  请介绍项目经验。  ' }], [], 'information_request', '2026-09-10T07:00:00.000Z');
  saveContext(owner, bossCard, 'boss', linkedConversation, 'resume-group', [{ kind: 'resume_request', text: 'HR 邀请你发送简历' }], [{ kind: 'resume_request' }], 'information_request', NOW);
  recordEvent(bossCard, 'message_group_classified', {
    platform: 'boss', threadKey: linkedConversation, messageIntent: 'interview_invitation'
  }, '2026-09-10T07:30:00.000Z');

  const historyConversation = digest('history-conversation');
  const historyCard = createCard(owner, 'zhaopin', historyConversation, 'History role', 'History Co');
  recordEvent(historyCard, 'resume_requested', { platform: 'zhaopin', threadKey: historyConversation }, '2026-09-09T09:00:00.000Z');
  recordEvent(historyCard, 'interview_invited', { platform: 'zhaopin', threadKey: historyConversation }, '2026-09-09T10:00:00.000Z');

  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: owner.profileId, platform: 'boss', conversationKey: linkedConversation,
    previewDigest: digest('linked-preview'), previewKind: 'possible_hr_reply',
    reasonCode: 'BOSS_MESSAGE_CARD_NOT_FOUND', observedAt: NOW,
    identity: { positionTitle: 'BOSS role', company: 'BOSS Co', salary: '', city: '' },
    sourceJobId: 'boss:synthetic_123456', lastMessageId: '123456789012345',
    inboundMessages: [{ kind: 'text', text: '请介绍项目经验。' }]
  });

  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: owner.profileId, platform: 'zhaopin', conversationKey: unresolvedConversation,
    previewDigest: digest('unresolved-preview'), previewKind: 'possible_hr_reply',
    reasonCode: 'ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED', observedAt: NOW,
    identity: { positionTitle: 'Unresolved role', company: 'Unresolved Co', salary: '', city: '' },
    sourceJobId: 'zhaopin:ZL123456', lastMessageId: '123456',
    inboundMessages: [{ kind: 'text', text: '请发一下作品集。' }, { kind: 'resume_request', text: 'HR 邀请你发送简历' }]
  });
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: owner.profileId, platform: 'boss', conversationKey: blankConversation,
    previewDigest: digest('blank-preview'), previewKind: 'possible_hr_reply',
    reasonCode: 'BOSS_MESSAGE_CARD_NOT_FOUND', observedAt: NOW,
    identity: { positionTitle: 'Blank role', company: 'Blank Co', salary: '', city: '' }
  });

  const sameKeyOtherPlatform = createCard(owner, 'zhaopin', linkedConversation, 'Other platform', 'Other platform Co');
  saveContext(owner, sameKeyOtherPlatform, 'zhaopin', linkedConversation, 'cross-platform', [{ kind: 'text', text: '智联消息' }], [], 'general_communication', NOW);
  const otherCard = createCard(other, 'boss', linkedConversation, 'Other profile', 'Other profile Co');
  saveContext(other, otherCard, 'boss', linkedConversation, 'other-profile', [{ kind: 'text', text: '其他候选人消息' }], [], 'general_communication', NOW);

  const orphanCard = createCard(owner, 'boss', '', 'Orphan role', 'Orphan Co');
  recordEvent(orphanCard, 'resume_requested', { platform: 'boss', threadKey: digest('unrelated-thread') }, NOW);

  const textRequestConversation = digest('text-request-conversation');
  const textRequestCard = createCard(owner, 'boss', textRequestConversation, 'Text request role', 'Text request Co');
  saveContext(owner, textRequestCard, 'boss', textRequestConversation, 'text-request',
    [{ kind: 'text', text: '08-04 14:53 您好，我们是一家软件企业，公司已上市，方便发份详细的简历过来吗？' }], [], 'information_request', NOW);
  const noSendConversation = digest('no-send-conversation');
  const noSendCard = createCard(owner, 'boss', noSendConversation, 'No send role', 'No send Co');
  saveContext(owner, noSendCard, 'boss', noSendConversation, 'no-send',
    [{ kind: 'text', text: '不用发简历，谢谢。' }], [], 'information_request', NOW);
  const optionalNoSendConversation = digest('optional-no-send-conversation');
  const optionalNoSendCard = createCard(owner, 'boss', optionalNoSendConversation, 'Optional no send role', 'Optional no send Co');
  saveContext(owner, optionalNoSendCard, 'boss', optionalNoSendConversation, 'optional-no-send',
    [{ kind: 'text', text: '如果方便，也不用再发简历。' }], [], 'information_request', NOW);
  const receivedNoSendConversation = digest('received-no-send-conversation');
  const receivedNoSendCard = createCard(owner, 'boss', receivedNoSendConversation, 'Received no send role', 'Received no send Co');
  saveContext(owner, receivedNoSendCard, 'boss', receivedNoSendConversation, 'received-no-send',
    [{ kind: 'text', text: '已收到简历，后面不用发。' }], [], 'information_request', NOW);
  const praiseConversation = digest('praise-conversation');
  const praiseCard = createCard(owner, 'boss', praiseConversation, 'Praise role', 'Praise Co');
  saveContext(owner, praiseCard, 'boss', praiseConversation, 'praise',
    [{ kind: 'text', text: '你的简历写得很清楚。' }], [], 'information_request', NOW);
  const mentionConversation = digest('mention-conversation');
  const mentionCard = createCard(owner, 'boss', mentionConversation, 'Mention role', 'Mention Co');
  saveContext(owner, mentionCard, 'boss', mentionConversation, 'mention',
    [{ kind: 'text', text: '简历' }], [], 'information_request', NOW);

  const items = listIncomingContacts(db, { profileId: owner.profileId });
  assert.equal(items.length, 10, 'linked, history, unresolved, and same-key other-platform conversations are counted once each');
  assert.deepEqual(items.map(item => item.platform).sort(), ['boss', 'boss', 'boss', 'boss', 'boss', 'boss', 'boss', 'zhaopin', 'zhaopin', 'zhaopin']);

  const linked = find(items, 'boss', linkedConversation);
  assert.equal(linked.cardId, bossCard);
  assert.equal(linked.jobId !== null, true);
  assert.equal(linked.resumeRequested, true, 'a request card is immediate evidence without an outbound or 48-hour wait');
  assert.equal(linked.interviewInvited, true, 'only a reliable classified intent sets an interview invitation');
  assert.equal(linked.messageIntent, 'information_request', 'a duplicate unresolved item cannot replace a linked classification');
  assert.deepEqual(linked.sourceKinds, ['classification', 'context', 'unresolved']);
  assert.deepEqual(linked.inboundMessages, [
    { kind: 'text', text: '请介绍项目经验。' },
    { kind: 'resume_request', text: 'HR 邀请你发送简历' }
  ]);
  assert.equal(linked.key, incomingKey(owner.profileId, 'boss', linkedConversation));

  const history = find(items, 'zhaopin', historyConversation);
  assert.equal(history.resumeRequested, true, 'historical classified progress remains auditable after context cleanup');
  assert.equal(history.interviewInvited, true);
  assert.deepEqual(history.inboundMessages, []);

  const unresolved = find(items, 'zhaopin', unresolvedConversation);
  assert.equal(unresolved.cardId, null);
  assert.equal(unresolved.jobId, null);
  assert.equal(unresolved.resumeRequested, true, 'an unresolved request card is enough evidence');
  assert.deepEqual(unresolved.inboundMessages, [
    { kind: 'text', text: '请发一下作品集。' },
    { kind: 'resume_request', text: 'HR 邀请你发送简历' }
  ]);

  assert.equal(items.some(item => item.conversationKey === blankConversation), false, 'blank loading-only unresolved items are excluded');
  assert.equal(items.some(item => item.cardId === orphanCard), false, 'a historical card event without its own thread key does not invent a conversation');
  assert.equal(find(items, 'boss', textRequestConversation).resumeRequested, true, 'an explicit request in a full safe message body counts as a resume request');
  assert.equal(find(items, 'boss', noSendConversation).resumeRequested, false, 'a message saying not to send a resume does not count');
  assert.equal(find(items, 'boss', optionalNoSendConversation).resumeRequested, false, 'an optional no-send sentence does not count');
  assert.equal(find(items, 'boss', receivedNoSendConversation).resumeRequested, false, 'an already-received no-send sentence does not count');
  assert.equal(find(items, 'boss', praiseConversation).resumeRequested, false, 'praise mentioning a resume does not count');
  assert.equal(find(items, 'boss', mentionConversation).resumeRequested, false, 'a bare resume mention does not count');
  assert.equal(listIncomingContacts(db, { profileId: other.profileId }).length, 1, 'profiles are isolated');
  console.log('incoming_contacts_smoke: ok');
} finally {
  db.close();
}

function createOwner(name) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at)
    VALUES (?, '{}', ?, ?)`).run(name, NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at)
    VALUES (?, ?, '{}', 1, ?, ?)`).run(profileId, `${name} plan`, NOW, NOW).lastInsertRowid);
  return { profileId, planId };
}

function createCard(owner, platform, threadKey, title, company) {
  const jobId = Number(db.prepare(`INSERT INTO jobs(source, source_id, title, company, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(platform, `${platform}-${++serial}`, title, company, NOW, NOW).lastInsertRowid);
  return Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, thread_key, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'needs_user_action', '', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, jobId, platform, threadKey, NOW, NOW, NOW).lastInsertRowid);
}

function saveContext(owner, cardId, platform, conversationKey, group, inboundMessages, manualActions, messageIntent, updatedAt) {
  storage.saveMessageInboundContext(db, {
    profileId: owner.profileId, cardId, platform, conversationKey, messageGroupKey: digest(group),
    sourceJobId: platform === 'boss' ? 'boss:synthetic_123456' : 'zhaopin:ZL123456',
    lastMessageId: platform === 'boss' ? '123456789012345' : '123456',
    messageIntent, messageCategory: 'other', inboundMessages, manualActions,
    createdAt: updatedAt, updatedAt
  });
}

function recordEvent(cardId, type, metadata, occurredAt) {
  db.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, 'system', '', ?, ?, ?)`)
    .run(cardId, `event-${++serial}`, type, JSON.stringify(metadata), occurredAt, occurredAt);
}

function find(items, platform, conversationKey) {
  const item = items.find(row => row.platform === platform && row.conversationKey === conversationKey);
  assert.ok(item, `missing ${platform} conversation`);
  return item;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function incomingKey(profileId, platform, conversationKey) {
  return digest(['incoming-contact-v1', profileId, platform, conversationKey].join('\0'));
}
